import path from "node:path";
import type { StreamerClonedRendition, StreamerClonedVariant } from "./model.js";

type RenditionKind = "AUDIO" | "SUBTITLES";

export function buildLocalDashMpd(params: {
  variants: StreamerClonedVariant[];
  renditions: StreamerClonedRendition[];
  rootRelative: boolean;
}): string {
  const media = [
    ...params.variants.map((variant, index) => ({ kind: "VIDEO" as const, index, item: variant })),
    ...params.renditions.map((rendition, index) => ({
      kind: requireRenditionKind(rendition.type),
      index,
      item: rendition,
    })),
  ];
  const durationSeconds = Math.max(
    ...media.map((entry) => entry.item.cumulativeDurationSeconds).filter((value) => Number.isFinite(value)),
    1,
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${formatIsoDuration(durationSeconds)}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-main:2011">`,
    `  <Period id="0" duration="${formatIsoDuration(durationSeconds)}">`,
  ];

  for (const entry of media) {
    lines.push(...formatAdaptationSet(entry.item, entry.kind, entry.index, params.rootRelative));
  }
  lines.push("  </Period>", "</MPD>");
  return `${lines.join("\n")}\n`;
}

function formatAdaptationSet(
  item: StreamerClonedVariant | StreamerClonedRendition,
  kind: "VIDEO" | RenditionKind,
  index: number,
  rootRelative: boolean,
): string[] {
  const source = "variant" in item ? item.variant : undefined;
  const contentType = kind === "VIDEO" ? "video" : kind === "AUDIO" ? "audio" : "text";
  const mimeType =
    source?.mimeType ??
    ("mimeType" in item ? item.mimeType : undefined) ??
    (kind === "VIDEO" ? "video/mp4" : kind === "AUDIO" ? "audio/mp4" : "text/vtt");
  const codecs = source?.codecs ?? ("codecs" in item ? item.codecs : undefined);
  const representationId =
    source?.id ?? ("id" in item ? item.id : undefined) ?? `${contentType}-${index}`;
  const bandwidth =
    source?.bandwidth ??
    ("bandwidth" in item ? item.bandwidth : undefined) ??
    estimateBandwidth(item);
  const resolution = source?.resolution?.split("x");
  const width = resolution?.[0];
  const height = resolution?.[1];
  const mediaDir = rootRelative ? path.dirname(item.localUri) : ".";
  const prefix = mediaDir === "." ? "" : `${mediaDir}/`;
  const timescale = 1000;
  const lines = [
    `    <AdaptationSet id="${xmlEscape(`${contentType}-${index}`)}" contentType="${contentType}" mimeType="${xmlEscape(mimeType)}"${codecs ? ` codecs="${xmlEscape(codecs)}"` : ""}${"language" in item && item.language ? ` lang="${xmlEscape(item.language)}"` : ""}>`,
    `      <Representation id="${xmlEscape(representationId)}" bandwidth="${Math.max(1, Math.ceil(bandwidth))}"${width && height ? ` width="${xmlEscape(width)}" height="${xmlEscape(height)}"` : ""}${source?.frameRate ? ` frameRate="${source.frameRate}"` : ""}>`,
    `        <SegmentList timescale="${timescale}">`,
  ];
  const init = item.maps[0];
  if (init) {
    lines.push(`          <Initialization sourceURL="${xmlEscape(`${prefix}${init.localUri}`)}"/>`);
  }
  lines.push("          <SegmentTimeline>");
  for (const segment of item.segments) {
    const durationMs = Math.max(1, Math.round((segment.duration ?? item.targetDuration) * timescale));
    lines.push(`            <S d="${durationMs}"/>`);
  }
  lines.push("          </SegmentTimeline>");
  for (const segment of item.segments) {
    lines.push(`          <SegmentURL media="${xmlEscape(`${prefix}${segment.localUri}`)}"/>`);
  }
  lines.push("        </SegmentList>", "      </Representation>", "    </AdaptationSet>");
  return lines;
}

function requireRenditionKind(type: string): RenditionKind {
  const normalized = type.toUpperCase();
  if (normalized === "AUDIO" || normalized === "SUBTITLES") {
    return normalized;
  }
  throw new Error(`unsupported rendition type: ${type}`);
}

function estimateBandwidth(item: StreamerClonedVariant | StreamerClonedRendition): number {
  if (item.cumulativeDurationSeconds <= 0) {
    return Math.max(1, item.bytes * 8);
  }
  return Math.max(1, Math.ceil((item.bytes * 8) / item.cumulativeDurationSeconds));
}

function formatIsoDuration(seconds: number): string {
  return `PT${Math.max(0.001, seconds).toFixed(3)}S`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
