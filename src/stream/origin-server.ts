import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type {
  StreamerCloneResult,
  StreamerClonedMap,
  StreamerClonedRendition,
  StreamerClonedSegment,
  StreamerClonedVariant,
  StreamerLiveServeHandle,
  StreamerLiveServeOptions,
  StreamerServeHandle,
  StreamerServeOptions,
} from "./model.js";
import { formatRenditionAttrs, formatVariantAttrs, renditionGroupIdsFor } from "./hls-manifests.js";
import { sanitizeOriginId, type StreamerOriginStore } from "./origin-store.js";

type RenditionKind = "AUDIO" | "SUBTITLES";
type RenditionRef = {
  kind: RenditionKind;
  routeIndex: number;
  rendition: StreamerClonedRendition;
};
type ClonedMediaSource = {
  localUri: string;
  targetDuration: number;
  segments: StreamerClonedSegment[];
};
type LiveState = {
  startedAtMs: number;
  windowSize: number;
  initialMediaSequence: number;
};

const DEFAULT_LIVE_WINDOW_SIZE = 5;
const DEFAULT_INITIAL_MEDIA_SEQUENCE = 100_000;

export async function serveOrigin(
  store: StreamerOriginStore,
  originId: string,
  options: StreamerServeOptions = {},
): Promise<StreamerServeHandle> {
  const id = sanitizeOriginId(originId);
  const clone = await store.load(id);
  const playbackPath = clone.playbackPath || "/index.m3u8";
  await fs.access(path.join(clone.rootDir, playbackPath.replace(/^\/+/, "")));

  const host = options.host?.trim() || "127.0.0.1";
  const port = normalizePort(options.port);
  const server = http.createServer((request, response) => {
    void handleStaticRequest(clone.rootDir, playbackPath, request, response);
  });
  await listen(server, host, port);

  const baseUrl = serverBaseUrl(server, host);
  return {
    originId: id,
    rootDir: clone.rootDir,
    baseUrl,
    playbackUrl: `${baseUrl}${playbackPath}`,
    close: () => closeServer(server),
  };
}

export async function serveLiveOrigin(
  store: StreamerOriginStore,
  originId: string,
  options: StreamerLiveServeOptions = {},
): Promise<StreamerLiveServeHandle> {
  const id = sanitizeOriginId(originId);
  const clone = await store.load(id);
  if ((clone.protocol ?? "hls") !== "hls") {
    throw new Error("streamer live currently supports HLS origins only");
  }

  const host = options.host?.trim() || "127.0.0.1";
  const port = normalizePort(options.port);
  const state: LiveState = {
    startedAtMs: Date.now(),
    windowSize: Math.max(1, Math.min(30, Math.floor(options.windowSize ?? DEFAULT_LIVE_WINDOW_SIZE))),
    initialMediaSequence: Math.max(
      0,
      Math.floor(options.initialMediaSequence ?? DEFAULT_INITIAL_MEDIA_SEQUENCE),
    ),
  };
  const server = http.createServer((request, response) => {
    void handleLiveRequest(clone, state, request, response);
  });
  await listen(server, host, port);

  const baseUrl = serverBaseUrl(server, host);
  return {
    originId: id,
    rootDir: clone.rootDir,
    baseUrl,
    playbackUrl: `${baseUrl}/index.m3u8`,
    windowSize: state.windowSize,
    initialMediaSequence: state.initialMediaSequence,
    close: () => closeServer(server),
  };
}

async function handleStaticRequest(
  rootDir: string,
  defaultPlaybackPath: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (!prepareResponse(request, response)) return;

  try {
    const requestUrl = new URL(request.url || "/", "http://streamer.local");
    const pathname = requestUrl.pathname === "/" ? defaultPlaybackPath : requestUrl.pathname;
    const relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
    const filePath = path.resolve(rootDir, relativePath);
    const safeRoot = path.resolve(rootDir);
    if (filePath !== safeRoot && !filePath.startsWith(`${safeRoot}${path.sep}`)) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }
    await sendFile(filePath, request.method, response);
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
}

async function handleLiveRequest(
  clone: StreamerCloneResult,
  state: LiveState,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (!prepareResponse(request, response)) return;

  try {
    const requestUrl = new URL(request.url || "/", "http://streamer.live");
    const pathname = requestUrl.pathname === "/" ? "/index.m3u8" : requestUrl.pathname;
    if (pathname === "/index.m3u8") {
      const body =
        clone.variants.length > 1 || clone.renditions.length > 0
          ? buildLiveMasterPlaylist(clone.variants, clone.renditions)
          : buildLiveMediaPlaylist(clone.variants[0], "/live/0", state, Date.now());
      sendText(response, request.method, body, "application/vnd.apple.mpegurl");
      return;
    }

    const variantManifest = pathname.match(/^\/live\/(\d+)\/index\.m3u8$/);
    if (variantManifest) {
      const index = parseVariantIndex(clone, variantManifest[1]);
      sendText(
        response,
        request.method,
        buildLiveMediaPlaylist(clone.variants[index], `/live/${index}`, state, Date.now()),
        "application/vnd.apple.mpegurl",
      );
      return;
    }

    const renditionManifest = pathname.match(/^\/live\/(audio|subtitles)\/(\d+)\/index\.m3u8$/);
    if (renditionManifest) {
      const ref = findRenditionRef(
        clone.renditions,
        renditionKindFromRoute(renditionManifest[1]),
        parseRenditionIndex(renditionManifest[2]),
      );
      sendText(
        response,
        request.method,
        buildLiveMediaPlaylist(ref.rendition, liveRenditionPath(ref), state, Date.now()),
        "application/vnd.apple.mpegurl",
      );
      return;
    }

    const variantSegment = pathname.match(/^\/live\/(\d+)\/segments\/(\d+)(?:\.[^/]*)?$/);
    if (variantSegment) {
      const variant = clone.variants[parseVariantIndex(clone, variantSegment[1])];
      await sendMediaSegment(clone.rootDir, variant, parseSequence(variantSegment[2]), request, response);
      return;
    }

    const renditionSegment = pathname.match(/^\/live\/(audio|subtitles)\/(\d+)\/segments\/(\d+)(?:\.[^/]*)?$/);
    if (renditionSegment) {
      const ref = findRenditionRef(
        clone.renditions,
        renditionKindFromRoute(renditionSegment[1]),
        parseRenditionIndex(renditionSegment[2]),
      );
      await sendMediaSegment(clone.rootDir, ref.rendition, parseSequence(renditionSegment[3]), request, response);
      return;
    }

    const variantMap = pathname.match(/^\/live\/(\d+)\/init\/([^/]+)$/);
    if (variantMap) {
      const variant = clone.variants[parseVariantIndex(clone, variantMap[1])];
      await sendMediaMap(clone.rootDir, variant, variantMap[2], request, response);
      return;
    }

    const renditionMap = pathname.match(/^\/live\/(audio|subtitles)\/(\d+)\/init\/([^/]+)$/);
    if (renditionMap) {
      const ref = findRenditionRef(
        clone.renditions,
        renditionKindFromRoute(renditionMap[1]),
        parseRenditionIndex(renditionMap[2]),
      );
      await sendMediaMap(clone.rootDir, ref.rendition, renditionMap[3], request, response);
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
}

function prepareResponse(request: http.IncomingMessage, response: http.ServerResponse): boolean {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  response.setHeader("access-control-allow-headers", "range, origin, accept, content-type");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return false;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end("method not allowed");
    return false;
  }
  return true;
}

async function sendMediaSegment(
  rootDir: string,
  media: ClonedMediaSource,
  sequence: number,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const segment = segmentForSequence(media, sequence);
  await sendFile(resolveClonedSegmentPath(rootDir, media, segment), request.method, response);
}

async function sendMediaMap(
  rootDir: string,
  media: ClonedMediaSource & { maps?: StreamerClonedMap[] },
  rawName: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const localUri = `init/${decodeURIComponent(rawName ?? "")}`;
  const clonedMap = (media.maps ?? []).find((candidate) => candidate.localUri === localUri);
  if (!clonedMap) throw new Error("live init segment not found");
  await sendFile(resolveClonedMapPath(rootDir, media, clonedMap), request.method, response);
}

async function sendFile(
  filePath: string,
  method: string | undefined,
  response: http.ServerResponse,
): Promise<void> {
  const data = await fs.readFile(filePath);
  response.statusCode = 200;
  response.setHeader("content-type", contentTypeFor(filePath));
  response.setHeader("cache-control", "no-store");
  response.end(method === "HEAD" ? undefined : data);
}

function buildLiveMasterPlaylist(
  variants: StreamerClonedVariant[],
  renditions: StreamerClonedRendition[],
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const audioGroupIds = renditionGroupIdsFor(renditions, "AUDIO");
  const subtitleGroupIds = renditionGroupIdsFor(renditions, "SUBTITLES");
  for (const ref of buildRenditionRefs(renditions)) {
    lines.push(`#EXT-X-MEDIA:${formatRenditionAttrs(ref.rendition, `${liveRenditionPath(ref)}/index.m3u8`)}`);
  }
  for (let index = 0; index < variants.length; index += 1) {
    lines.push(`#EXT-X-STREAM-INF:${formatVariantAttrs(variants[index], audioGroupIds, subtitleGroupIds)}`);
    lines.push(`/live/${index}/index.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}

function buildLiveMediaPlaylist(
  media: ClonedMediaSource,
  pathPrefix: string,
  state: LiveState,
  nowMs: number,
): string {
  const currentSequence = currentLiveSequence(media, state, nowMs);
  const mediaSequence = Math.max(state.initialMediaSequence, currentSequence - state.windowSize + 1);
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${media.segments.some((segment) => segment.map) ? 7 : 3}`,
    `#EXT-X-TARGETDURATION:${media.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(Math.max(0, mediaSequence - state.initialMediaSequence) / media.segments.length)}`,
  ];
  let activeMapUri: string | null = null;
  for (let sequence = mediaSequence; sequence <= currentSequence; sequence += 1) {
    const segment = segmentForSequence(media, sequence);
    const previous =
      sequence > mediaSequence || mediaSequence > state.initialMediaSequence
        ? segmentForSequence(media, sequence - 1)
        : null;
    if (segment.originalIndex === 0 && previous !== null && previous.originalIndex !== 0) {
      lines.push("#EXT-X-DISCONTINUITY");
      activeMapUri = null;
    }
    if (segment.map && segment.map.localUri !== activeMapUri) {
      lines.push(`#EXT-X-MAP:URI="${pathPrefix}/${segment.map.localUri}"`);
      activeMapUri = segment.map.localUri;
    }
    lines.push(`#EXTINF:${(segment.duration ?? media.targetDuration).toFixed(3)},${segment.title ?? ""}`);
    lines.push(`${pathPrefix}/segments/${sequence}${extensionForSegment(segment)}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildRenditionRefs(renditions: StreamerClonedRendition[]): RenditionRef[] {
  const nextIndex: Record<RenditionKind, number> = { AUDIO: 0, SUBTITLES: 0 };
  return renditions.flatMap((rendition) => {
    const kind = normalizeRenditionKind(rendition.type);
    if (!kind) return [];
    const ref = { kind, routeIndex: nextIndex[kind], rendition };
    nextIndex[kind] += 1;
    return [ref];
  });
}

function findRenditionRef(
  renditions: StreamerClonedRendition[],
  kind: RenditionKind,
  routeIndex: number,
): RenditionRef {
  const ref = buildRenditionRefs(renditions).find(
    (candidate) => candidate.kind === kind && candidate.routeIndex === routeIndex,
  );
  if (!ref) throw new Error("invalid live rendition index");
  return ref;
}

function liveRenditionPath(ref: RenditionRef): string {
  return `/live/${ref.kind === "AUDIO" ? "audio" : "subtitles"}/${ref.routeIndex}`;
}

function normalizeRenditionKind(type: string): RenditionKind | null {
  const normalized = type.toUpperCase();
  return normalized === "AUDIO" || normalized === "SUBTITLES" ? normalized : null;
}

function renditionKindFromRoute(raw: string | undefined): RenditionKind {
  if (raw === "audio") return "AUDIO";
  if (raw === "subtitles") return "SUBTITLES";
  throw new Error("invalid live rendition kind");
}

function parseVariantIndex(clone: StreamerCloneResult, raw: string | undefined): number {
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= clone.variants.length) {
    throw new Error("invalid live variant index");
  }
  return index;
}

function parseRenditionIndex(raw: string | undefined): number {
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) throw new Error("invalid live rendition index");
  return index;
}

function parseSequence(raw: string | undefined): number {
  const sequence = Number(raw);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid live segment sequence");
  return sequence;
}

function segmentForSequence(media: ClonedMediaSource, sequence: number): StreamerClonedSegment {
  if (media.segments.length === 0) throw new Error("variant has no segments");
  return media.segments[sequence % media.segments.length];
}

function currentLiveSequence(media: ClonedMediaSource, state: LiveState, nowMs: number): number {
  const elapsedSegments = Math.max(0, Math.floor((nowMs - state.startedAtMs) / Math.max(1, media.targetDuration * 1000)));
  return state.initialMediaSequence + state.windowSize - 1 + elapsedSegments;
}

function resolveClonedSegmentPath(
  rootDir: string,
  media: ClonedMediaSource,
  segment: StreamerClonedSegment,
): string {
  const mediaDir = path.dirname(media.localUri);
  return path.join(rootDir, mediaDir === "." ? "" : mediaDir, segment.localUri);
}

function resolveClonedMapPath(rootDir: string, media: ClonedMediaSource, map: StreamerClonedMap): string {
  const mediaDir = path.dirname(media.localUri);
  return path.join(rootDir, mediaDir === "." ? "" : mediaDir, map.localUri);
}

function extensionForSegment(segment: StreamerClonedSegment): string {
  return path.extname(segment.localUri) || ".ts";
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mpd") return "application/dash+xml";
  if (ext === ".m3u8") return "application/vnd.apple.mpegurl";
  if (ext === ".ts") return "video/mp2t";
  if (ext === ".m4s") return "video/iso.segment";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".webvtt" || ext === ".vtt") return "text/vtt";
  return "application/octet-stream";
}

function sendText(
  response: http.ServerResponse,
  method: string | undefined,
  body: string,
  contentType: string,
): void {
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(method === "HEAD" ? undefined : body);
}

function normalizePort(port: number | undefined): number {
  return Math.max(0, Math.min(65_535, Math.floor(port ?? 0)));
}

async function listen(server: http.Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverBaseUrl(server: http.Server, host: string): string {
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
