import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  DashInspectResult,
  MediaInspector,
} from "../inspect.js";
import type {
  StreamerCloneInput,
  StreamerCloneProgressEvent,
  StreamerCloneResult,
  StreamerClonedMap,
  StreamerClonedRendition,
  StreamerClonedSegment,
  StreamerClonedVariant,
} from "./model.js";
import { buildLocalDashMpd } from "./dash-manifests.js";
import { buildSegmentFileName, minVariantDuration } from "./clone-utils.js";
import { normalizeCloneOptions } from "./options.js";
import { sanitizeOriginId, type StreamerOriginStore } from "./origin-store.js";
import type { SegmentDownloader } from "./segment-downloader.js";
import { selectDashSegmentWindow } from "./segment-window.js";

type DashInspectService = Pick<MediaInspector, "inspectDash">;
type DashRepresentation = DashInspectResult["representations"][number];
type ProgressEmitter = (event: StreamerCloneProgressEvent) => void;

const STREAMER_ORIGIN_SCHEMA_VERSION = 2;

export async function cloneDash(params: {
  inspect: Partial<DashInspectService>;
  store: StreamerOriginStore;
  downloader: SegmentDownloader;
  rootDir: string;
  input: StreamerCloneInput;
}): Promise<StreamerCloneResult> {
  if (!params.inspect.inspectDash) {
    throw new Error("streamer DASH clone requires inspectDash support in MediaInspector");
  }

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

  const root = await params.inspect.inspectDash({
    url: input.url,
    maxSegments: options.maxSegments,
    timeoutMs: options.timeoutMs,
  });
  const downloadable = root.representations.filter(
    (representation) => representation.segments.length > 0,
  );
  emit({
    type: "manifest_ready",
    url: root.finalUrl,
    playlistType: "dash",
    variantCount: downloadable.filter(
      (representation) => representation.contentType === "video",
    ).length,
    segmentCount: downloadable.reduce(
      (sum, representation) => sum + representation.segments.length,
      0,
    ),
  });
  if (!root.ok || downloadable.length === 0) {
    throw new Error(
      `DASH inspect failed: ${root.errors.join("; ") || "no downloadable representations"}`,
    );
  }

  const videoRepresentations = downloadable.filter(
    (representation) => representation.contentType === "video",
  );
  const primaryRepresentations =
    videoRepresentations.length > 0 ? videoRepresentations : downloadable;
  const selectedRepresentations = input.allVariants
    ? selectRepresentations(primaryRepresentations, input.maxVariants)
    : [selectRepresentation(primaryRepresentations, input.variant)];
  const selectedIds = new Set(selectedRepresentations.map((representation) => representation.id));
  const renditionRepresentations = downloadable.filter(
    (representation) =>
      representation.contentType !== "video" && !selectedIds.has(representation.id),
  );

  const clonedVariants: StreamerClonedVariant[] = [];
  for (let index = 0; index < selectedRepresentations.length; index += 1) {
    const representation = selectedRepresentations[index];
    emitRepresentationInspect(emit, representation, index, selectedRepresentations.length);
    clonedVariants.push(await cloneRepresentation({
      representation,
      originDir,
      localDir: `variants/${buildRepresentationDirName(index, representation)}`,
      options,
      index,
      count: selectedRepresentations.length,
      emit,
      downloader: params.downloader,
    }));
  }

  const clonedRenditions: StreamerClonedRendition[] = [];
  for (let index = 0; index < renditionRepresentations.length; index += 1) {
    const representation = renditionRepresentations[index];
    emitRepresentationInspect(emit, representation, index, renditionRepresentations.length);
    const kind = representation.contentType === "text" ? "SUBTITLES" : "AUDIO";
    const cloned = await cloneRepresentation({
      representation,
      originDir,
      localDir:
        `${kind === "AUDIO" ? "audio" : "subtitles"}/` +
        buildRepresentationDirName(index, representation),
      options,
      index,
      count: renditionRepresentations.length,
      emit,
      downloader: params.downloader,
    });
    clonedRenditions.push(toRendition(representation, kind, cloned));
  }

  await writeDashManifests(originDir, clonedVariants, clonedRenditions);

  const selectedRepresentation = selectedRepresentations[0];
  const cumulativeDurationSeconds = minVariantDuration(clonedVariants);
  const result: StreamerCloneResult = {
    id,
    schemaVersion: STREAMER_ORIGIN_SCHEMA_VERSION,
    protocol: "dash",
    sourceUrl: root.url,
    selectedUrl: selectedRepresentation.baseUrl,
    finalUrl: root.finalUrl,
    rootDir: originDir,
    manifestPath: path.join(originDir, "index.mpd"),
    playbackPath: "/index.mpd",
    requestedDurationSeconds: options.durationSeconds,
    requestedStartSeconds: options.startSeconds > 0 ? options.startSeconds : undefined,
    requestedStartSegment: options.startSegment,
    requestedSegmentCount: options.segmentCount,
    cumulativeDurationSeconds,
    reachedTargetDuration: clonedVariants.every((variant) => variant.reachedTargetDuration),
    targetDuration: Math.max(...clonedVariants.map((variant) => variant.targetDuration), 1),
    segmentCount: clonedVariants.reduce((sum, variant) => sum + variant.segmentCount, 0),
    variantCount: clonedVariants.length,
    renditionCount: clonedRenditions.length,
    bytes:
      clonedVariants.reduce((sum, variant) => sum + variant.bytes, 0) +
      clonedRenditions.reduce((sum, rendition) => sum + rendition.bytes, 0),
    allVariants: Boolean(input.allVariants),
    selectedVariant: toVariantSource(selectedRepresentation),
    createdAt: new Date().toISOString(),
    variants: clonedVariants,
    renditions: clonedRenditions,
    segments: clonedVariants.flatMap((variant) => variant.segments),
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

async function cloneRepresentation(params: {
  representation: DashRepresentation;
  originDir: string;
  localDir: string;
  options: ReturnType<typeof normalizeCloneOptions>;
  index: number;
  count: number;
  emit: ProgressEmitter;
  downloader: SegmentDownloader;
}): Promise<StreamerClonedVariant> {
  const representationDir = path.join(params.originDir, params.localDir);
  await fs.mkdir(path.join(representationDir, "segments"), { recursive: true });

  const selectedSegments = selectDashSegmentWindow(params.representation, {
    startSeconds: params.options.startSeconds,
    durationSeconds: params.options.durationSeconds,
    startSegment: params.options.startSegment,
    segmentCount: params.options.segmentCount,
  });
  if (selectedSegments.length === 0) {
    throw new Error("streamer DASH clone found no downloadable media segments");
  }
  params.emit({
    type: "variant_ready",
    variantIndex: params.index,
    variantCount: params.count,
    label: formatRepresentationLabel(params.representation),
    segmentCount: selectedSegments.length,
    targetDuration: deriveTargetDuration(params.representation),
  });

  let totalBytes = 0;
  let cumulativeDurationSeconds = 0;
  const maps: StreamerClonedMap[] = [];
  let map: StreamerClonedMap | undefined;
  if (params.representation.initialization) {
    const localUri = `init/${buildSegmentFileName(0, params.representation.initialization.uri)}`;
    await fs.mkdir(path.dirname(path.join(representationDir, localUri)), { recursive: true });
    const bytes = await params.downloader.fetch({
      url: params.representation.initialization.url,
      timeoutMs: params.options.segmentTimeoutMs,
      retries: params.options.segmentRetries,
      progress: () => undefined,
      variantIndex: params.index,
      variantCount: params.count,
      segmentIndex: 0,
      segmentCount: 0,
    });
    await fs.writeFile(path.join(representationDir, localUri), bytes);
    totalBytes += bytes.byteLength;
    map = {
      sourceUri: params.representation.initialization.uri,
      sourceUrl: params.representation.initialization.url,
      localUri,
      bytes: bytes.byteLength,
    };
    maps.push(map);
  }

  const segments: StreamerClonedSegment[] = [];
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
    await fs.writeFile(path.join(representationDir, localUri), bytes);
    totalBytes += bytes.byteLength;
    cumulativeDurationSeconds += selected.segment.duration ?? 0;
    segments.push({
      originalIndex: selected.index,
      sourceUri: selected.segment.uri,
      sourceUrl: selected.segment.url,
      localUri,
      duration: selected.segment.duration,
      timelineStartSeconds: selected.timelineStartSeconds,
      timelineEndSeconds: selected.timelineEndSeconds,
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

  return {
    sourceUri: params.representation.id ?? params.representation.baseUrl,
    sourceUrl: params.representation.baseUrl,
    finalUrl: params.representation.baseUrl,
    localUri: `${params.localDir}/index.mpd`,
    manifestPath: path.join(representationDir, "index.mpd"),
    targetDuration: deriveTargetDuration(params.representation, segments),
    segmentCount: segments.length,
    cumulativeDurationSeconds,
    reachedTargetDuration: cumulativeDurationSeconds >= params.options.durationSeconds,
    bytes: totalBytes,
    maps,
    variant: toVariantSource(params.representation),
    segments,
  };
}

async function writeDashManifests(
  originDir: string,
  variants: StreamerClonedVariant[],
  renditions: StreamerClonedRendition[],
): Promise<void> {
  await fs.writeFile(
    path.join(originDir, "index.mpd"),
    buildLocalDashMpd({ variants, renditions, rootRelative: true }),
    "utf-8",
  );
  for (const variant of variants) {
    await fs.writeFile(
      variant.manifestPath,
      buildLocalDashMpd({ variants: [variant], renditions: [], rootRelative: false }),
      "utf-8",
    );
  }
  for (const rendition of renditions) {
    await fs.writeFile(
      rendition.manifestPath,
      buildLocalDashMpd({ variants: [], renditions: [rendition], rootRelative: false }),
      "utf-8",
    );
  }
}

function toRendition(
  representation: DashRepresentation,
  kind: "AUDIO" | "SUBTITLES",
  cloned: StreamerClonedVariant,
): StreamerClonedRendition {
  return {
    type: kind,
    id: representation.id,
    groupId: representation.adaptationSetId,
    name: representation.id ?? kind.toLowerCase(),
    language: representation.lang,
    codecs: representation.codecs,
    mimeType: representation.mimeType,
    bandwidth: representation.bandwidth,
    audioSamplingRate: representation.audioSamplingRate,
    sourceUri: cloned.sourceUri,
    sourceUrl: cloned.sourceUrl,
    finalUrl: cloned.finalUrl,
    localUri: cloned.localUri,
    manifestPath: cloned.manifestPath,
    targetDuration: cloned.targetDuration,
    segmentCount: cloned.segmentCount,
    cumulativeDurationSeconds: cloned.cumulativeDurationSeconds,
    reachedTargetDuration: cloned.reachedTargetDuration,
    bytes: cloned.bytes,
    maps: cloned.maps,
    segments: cloned.segments,
  };
}

function selectRepresentations(
  representations: DashRepresentation[],
  maxVariants: number | undefined,
): DashRepresentation[] {
  if (representations.length === 0) {
    throw new Error("DASH MPD has no representations to clone");
  }
  const max =
    typeof maxVariants === "number" && Number.isFinite(maxVariants) && maxVariants > 0
      ? Math.floor(maxVariants)
      : representations.length;
  return representations.slice(0, max);
}

function selectRepresentation(
  representations: DashRepresentation[],
  selector: string | undefined,
): DashRepresentation {
  if (representations.length === 0) {
    throw new Error("DASH MPD has no representations to clone");
  }
  const normalized = selector?.trim().toLowerCase() || "highest";
  if (["aac-highest", "highest", "browser", "browser-compatible"].includes(normalized)) {
    return [...representations].sort(
      (left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0),
    )[0];
  }
  if (normalized === "aac-lowest" || normalized === "lowest") {
    return [...representations].sort(
      (left, right) => (left.bandwidth ?? Infinity) - (right.bandwidth ?? Infinity),
    )[0];
  }
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 0 && index < representations.length) {
    return representations[index];
  }
  throw new Error(
    `unknown DASH representation selector "${selector}". Use highest, lowest, or a zero-based index.`,
  );
}

function toVariantSource(
  representation: DashRepresentation,
): NonNullable<StreamerClonedVariant["variant"]> {
  return {
    id: representation.id,
    uri: representation.id ?? representation.baseUrl,
    url: representation.baseUrl,
    contentType: representation.contentType,
    mimeType: representation.mimeType,
    bandwidth: representation.bandwidth,
    resolution:
      typeof representation.width === "number" && typeof representation.height === "number"
        ? `${representation.width}x${representation.height}`
        : undefined,
    frameRate: representation.frameRate,
    codecs: representation.codecs,
  };
}

function formatRepresentationLabel(representation: DashRepresentation): string {
  const resolution =
    typeof representation.width === "number" && typeof representation.height === "number"
      ? `${representation.width}x${representation.height}`
      : undefined;
  return [
    representation.contentType,
    resolution,
    typeof representation.bandwidth === "number" ? `${representation.bandwidth}bps` : undefined,
    representation.codecs,
    representation.id,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ") || representation.baseUrl;
}

function emitRepresentationInspect(
  emit: ProgressEmitter,
  representation: DashRepresentation,
  index: number,
  count: number,
): void {
  emit({
    type: "variant_inspect",
    variantIndex: index,
    variantCount: count,
    label: formatRepresentationLabel(representation),
    url: representation.baseUrl,
  });
}

function deriveTargetDuration(
  representation: DashRepresentation,
  segments: StreamerClonedSegment[] = [],
): number {
  return Math.ceil(Math.max(
    ...segments
      .map((segment) => segment.duration)
      .filter((duration): duration is number => typeof duration === "number"),
    ...representation.segments
      .map((segment) => segment.duration)
      .filter((duration): duration is number => typeof duration === "number"),
    1,
  ));
}

function buildRepresentationDirName(
  index: number,
  representation: DashRepresentation,
): string {
  const resolution =
    typeof representation.width === "number" && typeof representation.height === "number"
      ? `${representation.width}x${representation.height}`
      : undefined;
  const readable =
    [representation.contentType, resolution, representation.id, representation.bandwidth]
      .filter((value): value is string | number => value !== undefined && value !== "")
      .join("-") || `representation-${index}`;
  return `${String(index).padStart(3, "0")}-${readable.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}
