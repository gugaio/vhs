import type { HlsInspectResult } from "../inspect.js";
import type {
  StreamerClonedRendition,
  StreamerClonedSegment,
  StreamerClonedVariant,
} from "./model.js";

type RenditionKind = "AUDIO" | "SUBTITLES";

export function buildLocalMasterPlaylist(
  variants: StreamerClonedVariant[],
  renditions: StreamerClonedRendition[] = [],
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const audioGroupIds = renditionGroupIdsFor(renditions, "AUDIO");
  const subtitleGroupIds = renditionGroupIdsFor(renditions, "SUBTITLES");

  for (const rendition of renditions) {
    lines.push(`#EXT-X-MEDIA:${formatRenditionAttrs(rendition, rendition.localUri)}`);
  }
  for (const variant of variants) {
    lines.push(`#EXT-X-STREAM-INF:${formatVariantAttrs(variant, audioGroupIds, subtitleGroupIds)}`);
    lines.push(variant.localUri);
  }
  return `${lines.join("\n")}\n`;
}

export function buildLocalMediaPlaylist(params: {
  source: HlsInspectResult;
  segments: StreamerClonedSegment[];
  targetDuration: number;
}): string {
  const mediaSequence = params.source.mediaSequence ?? 0;
  const version = params.segments.some((segment) => segment.map) ? 7 : 3;
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${params.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
    ...(typeof params.source.discontinuitySequence === "number"
      ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${params.source.discontinuitySequence}`]
      : []),
  ];

  let activeMapUri: string | null = null;
  for (const segment of params.segments) {
    if (params.source.discontinuityMarkers.includes(segment.originalIndex)) {
      lines.push("#EXT-X-DISCONTINUITY");
      activeMapUri = null;
    }
    if (segment.map && segment.map.localUri !== activeMapUri) {
      lines.push(`#EXT-X-MAP:URI="${segment.map.localUri}"`);
      activeMapUri = segment.map.localUri;
    }
    const duration = segment.duration ?? params.source.targetDuration ?? params.targetDuration;
    lines.push(`#EXTINF:${duration.toFixed(3)},${segment.title ?? ""}`);
    lines.push(segment.localUri);
  }

  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

export function formatVariantAttrs(
  cloned: StreamerClonedVariant,
  availableAudioGroupIds = new Set<string>(),
  availableSubtitleGroupIds = new Set<string>(),
): string {
  const attrs: string[] = [];
  const variant = cloned.variant;
  attrs.push(`BANDWIDTH=${variant?.bandwidth ?? estimateBandwidth(cloned)}`);
  if (typeof variant?.averageBandwidth === "number") attrs.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`);
  if (variant?.resolution) attrs.push(`RESOLUTION=${variant.resolution}`);
  if (typeof variant?.frameRate === "number") attrs.push(`FRAME-RATE=${variant.frameRate}`);
  if (variant?.codecs) attrs.push(`CODECS="${variant.codecs}"`);
  if (variant?.audioGroupId && availableAudioGroupIds.has(variant.audioGroupId)) {
    attrs.push(`AUDIO="${variant.audioGroupId}"`);
  }
  if (variant?.subtitlesGroupId && availableSubtitleGroupIds.has(variant.subtitlesGroupId)) {
    attrs.push(`SUBTITLES="${variant.subtitlesGroupId}"`);
  }
  if (variant?.closedCaptions) attrs.push(`CLOSED-CAPTIONS=${variant.closedCaptions}`);
  return attrs.join(",");
}

export function formatRenditionAttrs(rendition: StreamerClonedRendition, uri: string): string {
  return [
    `TYPE=${rendition.type.toUpperCase()}`,
    ...(rendition.groupId ? [`GROUP-ID=${quoteAttr(rendition.groupId)}`] : []),
    ...(rendition.language ? [`LANGUAGE=${quoteAttr(rendition.language)}`] : []),
    ...(rendition.name ? [`NAME=${quoteAttr(rendition.name)}`] : []),
    ...(typeof rendition.default === "boolean" ? [`DEFAULT=${rendition.default ? "YES" : "NO"}`] : []),
    ...(typeof rendition.autoselect === "boolean" ? [`AUTOSELECT=${rendition.autoselect ? "YES" : "NO"}`] : []),
    ...(typeof rendition.forced === "boolean" ? [`FORCED=${rendition.forced ? "YES" : "NO"}`] : []),
    ...(rendition.characteristics ? [`CHARACTERISTICS=${quoteAttr(rendition.characteristics)}`] : []),
    ...(rendition.channels ? [`CHANNELS=${quoteAttr(rendition.channels)}`] : []),
    `URI=${quoteAttr(uri)}`,
  ].join(",");
}

export function renditionGroupIdsFor(
  renditions: StreamerClonedRendition[],
  kind: RenditionKind,
): Set<string> {
  return new Set(
    renditions
      .filter((rendition) => rendition.type.toUpperCase() === kind)
      .map((rendition) => rendition.groupId)
      .filter((groupId): groupId is string => Boolean(groupId)),
  );
}

function quoteAttr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function estimateBandwidth(cloned: StreamerClonedVariant): number {
  if (cloned.cumulativeDurationSeconds <= 0) {
    return Math.max(1, cloned.bytes * 8);
  }
  return Math.max(1, Math.ceil((cloned.bytes * 8) / cloned.cumulativeDurationSeconds));
}
