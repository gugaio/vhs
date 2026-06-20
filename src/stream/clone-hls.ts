import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  HlsInspectResult,
  MediaInspector,
} from "../inspect.js";
import { isBrowserSafeHlsVariant } from "./diagnostics.js";
import type {
  StreamerCloneInput,
  StreamerCloneProgressEvent,
  StreamerCloneResult,
  StreamerClonedMap,
  StreamerClonedRendition,
  StreamerClonedSegment,
  StreamerClonedVariant,
} from "./model.js";
import {
  buildLocalMasterPlaylist,
  buildLocalMediaPlaylist,
} from "./hls-manifests.js";
import { normalizeCloneOptions } from "./options.js";
import { sanitizeOriginId, type StreamerOriginStore } from "./origin-store.js";
import type { SegmentDownloader } from "./segment-downloader.js";
import { selectHlsSegmentWindow } from "./segment-window.js";
import { buildSegmentFileName, minVariantDuration } from "./clone-utils.js";

type HlsInspectService = Pick<MediaInspector, "inspectHls">;
type VariantSource = NonNullable<StreamerClonedVariant["variant"]>;
type RenditionSource = HlsInspectResult["renditions"][number];
type RenditionKind = "AUDIO" | "SUBTITLES";
type ProgressEmitter = (event: StreamerCloneProgressEvent) => void;
type CloneOptions = ReturnType<typeof normalizeCloneOptions>;

type SelectedMediaPlaylist = {
  inspected: HlsInspectResult;
  selectedVariant?: StreamerCloneResult["selectedVariant"];
};

const RENDITION_KIND_CONFIG: Record<RenditionKind, "audio" | "subtitles"> = {
  AUDIO: "audio",
  SUBTITLES: "subtitles",
};

const STREAMER_ORIGIN_SCHEMA_VERSION = 2;

export async function cloneHls(params: {
  inspect: HlsInspectService;
  store: StreamerOriginStore;
  downloader: SegmentDownloader;
  rootDir: string;
  input: StreamerCloneInput;
}): Promise<StreamerCloneResult> {
  const input = params.input;
  const options = normalizeCloneOptions(input);
  const id = sanitizeOriginId(input.originId?.trim() || randomUUID());
  const originDir = path.join(params.rootDir, id);
  const emit = input.onProgress ?? (() => undefined);

  await fs.mkdir(originDir, { recursive: true });
  emit({
    type: "start",
    originId: id,
    url: input.url,
    durationSeconds: options.durationSeconds,
    startSeconds: options.startSeconds,
    ...(options.startSegment !== undefined ? { startSegment: options.startSegment } : {}),
    ...(options.segmentCount !== undefined ? { segmentCount: options.segmentCount } : {}),
    allVariants: Boolean(input.allVariants),
  });
  emit({ type: "manifest_fetch", url: input.url });

  const root = await params.inspect.inspectHls({
    url: input.url,
    maxSegments: options.maxSegments,
    timeoutMs: options.timeoutMs,
  });
  emit({
    type: "manifest_ready",
    url: root.finalUrl,
    playlistType: root.playlistType,
    variantCount: root.variants.length,
    segmentCount: root.segments.length,
  });

  const cloned = input.allVariants && root.playlistType === "master"
    ? await cloneAllVariants(params, root, originDir, options, input.maxVariants, emit)
    : await cloneSelectedVariant(params, root, originDir, options, input.variant, emit);
  const clonedSegments = cloned.variants.flatMap((variant) => variant.segments);
  const cumulativeDurationSeconds = minVariantDuration(cloned.variants);
  const result: StreamerCloneResult = {
    id,
    schemaVersion: STREAMER_ORIGIN_SCHEMA_VERSION,
    protocol: "hls",
    sourceUrl: root.url,
    selectedUrl: cloned.selectedUrl,
    finalUrl: cloned.finalUrl,
    rootDir: originDir,
    manifestPath: path.join(originDir, "index.m3u8"),
    playbackPath: "/index.m3u8",
    requestedDurationSeconds: options.durationSeconds,
    requestedStartSeconds: options.startSeconds > 0 ? options.startSeconds : undefined,
    requestedStartSegment: options.startSegment,
    requestedSegmentCount: options.segmentCount,
    cumulativeDurationSeconds,
    reachedTargetDuration: cloned.variants.every((variant) => variant.reachedTargetDuration),
    targetDuration: Math.max(...cloned.variants.map((variant) => variant.targetDuration), 1),
    segmentCount: cloned.variants.reduce((sum, variant) => sum + variant.segmentCount, 0),
    variantCount: cloned.variants.length,
    renditionCount: cloned.renditions.length,
    bytes:
      cloned.variants.reduce((sum, variant) => sum + variant.bytes, 0) +
      cloned.renditions.reduce((sum, rendition) => sum + rendition.bytes, 0),
    allVariants: cloned.allVariants,
    selectedVariant: cloned.selectedVariant,
    createdAt: new Date().toISOString(),
    variants: cloned.variants,
    renditions: cloned.renditions,
    segments: clonedSegments,
  };

  await params.store.save(result);
  emit({
    type: "complete",
    originId: id,
    segmentCount: result.segmentCount,
    variantCount: result.variantCount,
    bytes: result.bytes,
    cumulativeDurationSeconds: result.cumulativeDurationSeconds,
  });
  return result;
}

async function cloneAllVariants(
  dependencies: {
    inspect: HlsInspectService;
    downloader: SegmentDownloader;
  },
  root: HlsInspectResult,
  originDir: string,
  options: CloneOptions,
  maxVariants: number | undefined,
  emit: ProgressEmitter,
): Promise<ClonedHlsSelection> {
  const variants = selectAllVariants(root, maxVariants);
  const clonedVariants: StreamerClonedVariant[] = [];
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    emitVariantInspect(emit, variant, index, variants.length);
    const inspected = await dependencies.inspect.inspectHls({
      url: variant.url,
      maxSegments: options.maxSegments,
      timeoutMs: options.timeoutMs,
    });
    clonedVariants.push(await cloneMediaPlaylist({
      inspected,
      originDir,
      localDir: `variants/${buildVariantDirName(index, variant)}`,
      options,
      playlistSource: { uri: variant.uri, url: variant.url },
      variant,
      index,
      count: variants.length,
      emit,
      downloader: dependencies.downloader,
    }));
  }

  const renditions = await cloneLinkedRenditions({
    inspect: dependencies.inspect,
    downloader: dependencies.downloader,
    root,
    variants,
    originDir,
    options,
    emit,
  });
  await writeMasterPlaylist(originDir, clonedVariants, renditions);
  return {
    selectedUrl: root.url,
    finalUrl: root.finalUrl,
    allVariants: true,
    variants: clonedVariants,
    renditions,
  };
}

async function cloneSelectedVariant(
  dependencies: {
    inspect: HlsInspectService;
    downloader: SegmentDownloader;
  },
  root: HlsInspectResult,
  originDir: string,
  options: CloneOptions,
  variantSelector: string | undefined,
  emit: ProgressEmitter,
): Promise<ClonedHlsSelection> {
  if (root.playlistType === "master") {
    emitVariantInspect(emit, toVariantSource(selectVariant(root, variantSelector)), 0, 1);
  }
  const selected = await resolveMediaPlaylist(
    dependencies.inspect,
    root,
    variantSelector,
    options.maxSegments,
    options.timeoutMs,
  );
  const linkedRenditions =
    root.playlistType === "master" && selected.selectedVariant
      ? selectLinkedRenditions(root, [selected.selectedVariant])
      : [];
  const useLocalMaster = linkedRenditions.length > 0;
  const localDir =
    useLocalMaster && selected.selectedVariant
      ? `variants/${buildVariantDirName(0, selected.selectedVariant)}`
      : ".";
  const variants = [
    await cloneMediaPlaylist({
      inspected: selected.inspected,
      originDir,
      localDir,
      options,
      playlistSource: selected.selectedVariant
        ? { uri: selected.selectedVariant.uri, url: selected.selectedVariant.url }
        : undefined,
      variant: selected.selectedVariant,
      index: 0,
      count: 1,
      emit,
      downloader: dependencies.downloader,
    }),
  ];

  let renditions: StreamerClonedRendition[] = [];
  if (useLocalMaster && selected.selectedVariant) {
    renditions = await cloneLinkedRenditions({
      inspect: dependencies.inspect,
      downloader: dependencies.downloader,
      root,
      variants: [selected.selectedVariant],
      originDir,
      options,
      emit,
      renditions: linkedRenditions,
    });
    await writeMasterPlaylist(originDir, variants, renditions);
  }
  return {
    selectedUrl: selected.inspected.url,
    finalUrl: selected.inspected.finalUrl,
    allVariants: false,
    selectedVariant: selected.selectedVariant,
    variants,
    renditions,
  };
}

type ClonedHlsSelection = {
  selectedUrl: string;
  finalUrl: string;
  allVariants: boolean;
  selectedVariant?: StreamerCloneResult["selectedVariant"];
  variants: StreamerClonedVariant[];
  renditions: StreamerClonedRendition[];
};

async function resolveMediaPlaylist(
  inspect: HlsInspectService,
  root: HlsInspectResult,
  variantSelector: string | undefined,
  maxSegments: number,
  timeoutMs: number,
): Promise<SelectedMediaPlaylist> {
  if (root.playlistType === "media") {
    return { inspected: root };
  }
  if (root.playlistType !== "master") {
    throw new Error(`streamer clone supports HLS master/media playlists; got ${root.playlistType}`);
  }

  const variant = selectVariant(root, variantSelector);
  return {
    inspected: await inspect.inspectHls({
      url: variant.url,
      maxSegments,
      timeoutMs,
    }),
    selectedVariant: toVariantSource(variant),
  };
}

async function cloneMediaPlaylist(params: {
  inspected: HlsInspectResult;
  originDir: string;
  localDir: string;
  options: CloneOptions;
  playlistSource?: { uri: string; url: string };
  label?: string;
  variant?: VariantSource;
  index: number;
  count: number;
  emit: ProgressEmitter;
  downloader: SegmentDownloader;
}): Promise<StreamerClonedVariant> {
  if (params.inspected.playlistType !== "media") {
    throw new Error(`streamer clone supports HLS media playlists; got ${params.inspected.playlistType}`);
  }

  const variantDir =
    params.localDir === "." ? params.originDir : path.join(params.originDir, params.localDir);
  await fs.mkdir(path.join(variantDir, "segments"), { recursive: true });
  const selectedSegments = selectHlsSegmentWindow(params.inspected, {
    startSeconds: params.options.startSeconds,
    durationSeconds: params.options.durationSeconds,
    startSegment: params.options.startSegment,
    segmentCount: params.options.segmentCount,
  });
  if (selectedSegments.length === 0) {
    throw new Error("streamer clone found no downloadable media segments");
  }

  params.emit({
    type: "variant_ready",
    variantIndex: params.index,
    variantCount: params.count,
    label: params.variant
      ? formatVariantLabel(params.variant)
      : params.label ?? "media playlist direta",
    segmentCount: selectedSegments.length,
    targetDuration: params.inspected.targetDuration ?? 0,
  });

  const segments: StreamerClonedSegment[] = [];
  const mapsBySource = new Map<string, StreamerClonedMap>();
  let totalBytes = 0;
  let cumulativeDurationSeconds = 0;
  const ensureClonedMap = async (
    map: NonNullable<HlsInspectResult["segments"][number]["map"]>,
  ): Promise<StreamerClonedMap> => {
    if (map.byteRange) {
      throw new Error("streamer clone does not support EXT-X-MAP with BYTERANGE yet");
    }
    const existing = mapsBySource.get(map.url);
    if (existing) {
      return existing;
    }

    const localUri = `init/${buildSegmentFileName(mapsBySource.size, map.uri)}`;
    await fs.mkdir(path.dirname(path.join(variantDir, localUri)), { recursive: true });
    const bytes = await params.downloader.fetch({
      url: map.url,
      timeoutMs: params.options.segmentTimeoutMs,
      retries: params.options.segmentRetries,
      progress: () => undefined,
      variantIndex: params.index,
      variantCount: params.count,
      segmentIndex: 0,
      segmentCount: 0,
    });
    await fs.writeFile(path.join(variantDir, localUri), bytes);
    totalBytes += bytes.byteLength;
    const clonedMap: StreamerClonedMap = {
      sourceUri: map.uri,
      sourceUrl: map.url,
      localUri,
      bytes: bytes.byteLength,
    };
    mapsBySource.set(map.url, clonedMap);
    return clonedMap;
  };

  for (let index = 0; index < selectedSegments.length; index += 1) {
    const selected = selectedSegments[index];
    const localUri = `segments/${buildSegmentFileName(index, selected.segment.uri)}`;
    params.emit({
      type: "segment_download_start",
      variantIndex: params.index,
      variantCount: params.count,
      segmentIndex: index,
      segmentCount: selectedSegments.length,
      originalSegmentIndex: selected.index,
      url: selected.segment.url,
      duration: selected.segment.duration,
    });
    const bytes = await params.downloader.fetch({
      url: selected.segment.url,
      timeoutMs: params.options.segmentTimeoutMs,
      retries: params.options.segmentRetries,
      progress: params.emit,
      variantIndex: params.index,
      variantCount: params.count,
      segmentIndex: index,
      segmentCount: selectedSegments.length,
      originalSegmentIndex: selected.index,
    });
    const map = selected.segment.map
      ? await ensureClonedMap(selected.segment.map)
      : undefined;
    await fs.writeFile(path.join(variantDir, localUri), bytes);
    totalBytes += bytes.byteLength;
    cumulativeDurationSeconds +=
      selected.segment.duration ?? params.inspected.targetDuration ?? 0;
    segments.push({
      originalIndex: selected.index,
      sourceUri: selected.segment.uri,
      sourceUrl: selected.segment.url,
      localUri,
      duration: selected.segment.duration,
      timelineStartSeconds: selected.timelineStartSeconds,
      timelineEndSeconds: selected.timelineEndSeconds,
      title: selected.segment.title,
      bytes: bytes.byteLength,
      map,
    });
    params.emit({
      type: "segment_downloaded",
      variantIndex: params.index,
      variantCount: params.count,
      segmentIndex: index,
      segmentCount: selectedSegments.length,
      originalSegmentIndex: selected.index,
      localUri,
      bytes: bytes.byteLength,
      cumulativeBytes: totalBytes,
      cumulativeDurationSeconds,
    });
  }

  const targetDuration = deriveTargetDuration(params.inspected, segments);
  const manifestPath = path.join(variantDir, "index.m3u8");
  await fs.writeFile(
    manifestPath,
    buildLocalMediaPlaylist({
      source: params.inspected,
      segments,
      targetDuration,
    }),
    "utf-8",
  );
  return {
    sourceUri: params.playlistSource?.uri ?? params.variant?.uri ?? params.inspected.url,
    sourceUrl: params.playlistSource?.url ?? params.variant?.url ?? params.inspected.url,
    finalUrl: params.inspected.finalUrl,
    localUri: params.localDir === "." ? "index.m3u8" : `${params.localDir}/index.m3u8`,
    manifestPath,
    targetDuration,
    segmentCount: segments.length,
    cumulativeDurationSeconds,
    reachedTargetDuration: cumulativeDurationSeconds >= params.options.durationSeconds,
    bytes: totalBytes,
    maps: [...mapsBySource.values()],
    variant: params.variant,
    segments,
  };
}

async function cloneLinkedRenditions(params: {
  inspect: HlsInspectService;
  downloader: SegmentDownloader;
  root: HlsInspectResult;
  variants: VariantSource[];
  originDir: string;
  options: CloneOptions;
  emit: ProgressEmitter;
  renditions?: RenditionSource[];
}): Promise<StreamerClonedRendition[]> {
  const renditions = params.renditions ?? selectLinkedRenditions(params.root, params.variants);
  const cloned: StreamerClonedRendition[] = [];
  const nextIndexByKind: Record<RenditionKind, number> = {
    AUDIO: 0,
    SUBTITLES: 0,
  };

  for (let index = 0; index < renditions.length; index += 1) {
    const rendition = renditions[index];
    if (!rendition.uri || !rendition.url) {
      continue;
    }
    const kind = requireRenditionKind(rendition.type);
    const kindIndex = nextIndexByKind[kind];
    nextIndexByKind[kind] += 1;
    const label = formatRenditionLabel(rendition);
    params.emit({
      type: "variant_inspect",
      variantIndex: index,
      variantCount: renditions.length,
      label,
      url: rendition.url,
    });
    const inspected = await params.inspect.inspectHls({
      url: rendition.url,
      maxSegments: params.options.maxSegments,
      timeoutMs: params.options.timeoutMs,
    });
    const media = await cloneMediaPlaylist({
      inspected,
      originDir: params.originDir,
      localDir:
        `${renditionDirectory(rendition)}/${buildRenditionDirName(kindIndex, rendition)}`,
      options: params.options,
      playlistSource: { uri: rendition.uri, url: rendition.url },
      label,
      index,
      count: renditions.length,
      emit: params.emit,
      downloader: params.downloader,
    });
    cloned.push({
      type: rendition.type,
      groupId: rendition.groupId,
      name: rendition.name,
      language: rendition.language,
      default: rendition.default,
      autoselect: rendition.autoselect,
      forced: rendition.forced,
      channels: rendition.channels,
      characteristics: rendition.characteristics,
      sourceUri: media.sourceUri,
      sourceUrl: media.sourceUrl,
      finalUrl: media.finalUrl,
      localUri: media.localUri,
      manifestPath: media.manifestPath,
      targetDuration: media.targetDuration,
      segmentCount: media.segmentCount,
      cumulativeDurationSeconds: media.cumulativeDurationSeconds,
      reachedTargetDuration: media.reachedTargetDuration,
      bytes: media.bytes,
      maps: media.maps,
      segments: media.segments,
    });
  }
  return cloned;
}

async function writeMasterPlaylist(
  originDir: string,
  variants: StreamerClonedVariant[],
  renditions: StreamerClonedRendition[],
): Promise<void> {
  await fs.writeFile(
    path.join(originDir, "index.m3u8"),
    buildLocalMasterPlaylist(variants, renditions),
    "utf-8",
  );
}

function selectVariant(
  root: HlsInspectResult,
  selector: string | undefined,
): HlsInspectResult["variants"][number] {
  if (root.variants.length === 0) {
    throw new Error("master playlist has no variants to clone");
  }
  const normalized = selector?.trim().toLowerCase() || "aac-highest";
  if (["aac-highest", "browser", "browser-compatible"].includes(normalized)) {
    const safeVariants = root.variants.filter(isBrowserSafeHlsVariant);
    return selectHighestBandwidth(safeVariants.length > 0 ? safeVariants : root.variants);
  }
  if (normalized === "aac-lowest") {
    const safeVariants = root.variants.filter(isBrowserSafeHlsVariant);
    return selectLowestBandwidth(safeVariants.length > 0 ? safeVariants : root.variants);
  }
  if (normalized === "lowest") {
    return selectLowestBandwidth(root.variants);
  }
  if (normalized === "highest") {
    return selectHighestBandwidth(root.variants);
  }
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 0 && index < root.variants.length) {
    return root.variants[index];
  }
  throw new Error(
    `unknown variant selector "${selector}". Use aac-highest, highest, lowest, or a zero-based index.`,
  );
}

function selectHighestBandwidth<T extends { bandwidth?: number }>(variants: T[]): T {
  return [...variants].sort(
    (left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0),
  )[0];
}

function selectLowestBandwidth<T extends { bandwidth?: number }>(variants: T[]): T {
  return [...variants].sort(
    (left, right) => (left.bandwidth ?? Infinity) - (right.bandwidth ?? Infinity),
  )[0];
}

function selectAllVariants(
  root: HlsInspectResult,
  maxVariants: number | undefined,
): VariantSource[] {
  if (root.variants.length === 0) {
    throw new Error("master playlist has no variants to clone");
  }
  const max =
    typeof maxVariants === "number" && Number.isFinite(maxVariants) && maxVariants > 0
      ? Math.floor(maxVariants)
      : root.variants.length;
  return root.variants.slice(0, max).map(toVariantSource);
}

function selectLinkedRenditions(
  root: HlsInspectResult,
  variants: VariantSource[],
): RenditionSource[] {
  return [
    ...selectRenditionsByGroups(
      root,
      "AUDIO",
      variants
        .map((variant) => variant.audioGroupId)
        .filter((value): value is string => Boolean(value)),
    ),
    ...selectRenditionsByGroups(
      root,
      "SUBTITLES",
      variants
        .map((variant) => variant.subtitlesGroupId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function selectRenditionsByGroups(
  root: HlsInspectResult,
  type: RenditionKind,
  groupIds: string[],
): RenditionSource[] {
  const selectedGroupIds = new Set(groupIds);
  if (selectedGroupIds.size === 0) {
    return [];
  }

  const seen = new Set<string>();
  const selected: RenditionSource[] = [];
  for (const rendition of root.renditions) {
    if (
      rendition.type.toUpperCase() !== type ||
      !rendition.groupId ||
      !rendition.uri ||
      !rendition.url ||
      !selectedGroupIds.has(rendition.groupId)
    ) {
      continue;
    }
    const key = `${rendition.type}|${rendition.groupId}|${rendition.name ?? ""}|${rendition.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(rendition);
    }
  }
  return selected;
}

function requireRenditionKind(type: string): RenditionKind {
  const normalized = type.trim().toUpperCase();
  if (normalized === "AUDIO" || normalized === "SUBTITLES") {
    return normalized;
  }
  throw new Error(`unsupported rendition type "${type}"`);
}

function renditionDirectory(
  rendition: RenditionSource | StreamerClonedRendition,
): "audio" | "subtitles" {
  return RENDITION_KIND_CONFIG[requireRenditionKind(rendition.type)];
}

function toVariantSource(
  variant: HlsInspectResult["variants"][number],
): VariantSource {
  return {
    uri: variant.uri,
    url: variant.url,
    bandwidth: variant.bandwidth,
    averageBandwidth: variant.averageBandwidth,
    resolution: variant.resolution,
    frameRate: variant.frameRate,
    codecs: variant.codecs,
    audioGroupId: variant.audioGroupId,
    subtitlesGroupId: variant.subtitlesGroupId,
    closedCaptions: variant.closedCaptions,
  };
}

function emitVariantInspect(
  emit: ProgressEmitter,
  variant: VariantSource,
  index: number,
  count: number,
): void {
  emit({
    type: "variant_inspect",
    variantIndex: index,
    variantCount: count,
    label: formatVariantLabel(variant),
    url: variant.url,
  });
}

function formatVariantLabel(variant: VariantSource): string {
  const parts = [
    variant.resolution,
    typeof variant.bandwidth === "number" ? `${variant.bandwidth}bps` : undefined,
    variant.codecs,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" | ") : variant.uri;
}

function formatRenditionLabel(rendition: RenditionSource): string {
  const parts = [
    rendition.type,
    rendition.groupId,
    rendition.name,
    rendition.channels ? `${rendition.channels}ch` : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" | ") : rendition.uri ?? "rendition";
}

function buildVariantDirName(index: number, variant: VariantSource): string {
  let basename = "";
  try {
    basename = path.basename(new URL(variant.uri, "http://streamer.local").pathname);
  } catch {
    basename = path.basename(variant.uri);
  }
  const readable = variant.resolution || basename || `variant-${index}`;
  const safeBase = readable.replace(/[^a-zA-Z0-9._-]/g, "-") || `variant-${index}`;
  return `${String(index).padStart(3, "0")}-${safeBase}`;
}

function buildRenditionDirName(index: number, rendition: RenditionSource): string {
  let basename = "";
  if (rendition.uri) {
    try {
      basename = path.basename(new URL(rendition.uri, "http://streamer.local").pathname);
    } catch {
      basename = path.basename(rendition.uri);
    }
  }
  const fallback = `${renditionDirectory(rendition)}-${index}`;
  const readable =
    [rendition.groupId, rendition.name].filter(Boolean).join("-") || basename || fallback;
  const safeBase = readable.replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
  return `${String(index).padStart(3, "0")}-${safeBase}`;
}

function deriveTargetDuration(
  source: HlsInspectResult,
  segments: StreamerClonedSegment[],
): number {
  if (
    typeof source.targetDuration === "number" &&
    Number.isFinite(source.targetDuration) &&
    source.targetDuration > 0
  ) {
    return Math.ceil(source.targetDuration);
  }
  return Math.ceil(Math.max(
    ...segments
      .map((segment) => segment.duration)
      .filter((duration): duration is number => typeof duration === "number"),
    1,
  ));
}
