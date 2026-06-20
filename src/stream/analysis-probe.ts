import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MediaInspector } from "../inspect.js";
import type {
  StreamerCloneResult,
  StreamerClonedSegment,
  StreamerOriginAnalysisReport,
} from "./model.js";

type MediaType = "AUDIO" | "SUBTITLES" | "VIDEO";

export type StreamerAnalyzeCandidate = {
  kind: "variant" | "rendition";
  index: number;
  type: MediaType;
  label: string;
  manifestPath: string;
  rootPath: string;
  segments: StreamerClonedSegment[];
};

type ProbeResult = {
  format?: unknown;
  timeline?: {
    firstPtsTime?: number;
    lastPtsTime?: number;
    lastSampleDurationTime?: number;
  };
};

export async function analyzeCandidate(params: {
  candidate: StreamerAnalyzeCandidate;
  probe: NonNullable<MediaInspector["probe"]>;
  timeoutMs: number;
  maxSegments: number;
  startSegment?: number;
  segmentCount?: number;
}): Promise<StreamerOriginAnalysisReport["entries"]> {
  const entries: StreamerOriginAnalysisReport["entries"] = [];
  const { candidate } = params;

  for (const segmentIndex of sampleAnalyzeSegmentIndices(
    candidate.segments,
    params.maxSegments,
    params.startSegment,
    params.segmentCount,
  )) {
    const segment = candidate.segments[segmentIndex];
    const localPath = path.join(candidate.rootPath, segment.localUri);
    const probeInput = await prepareSegmentProbeInput(candidate.rootPath, segment, localPath);
    let result;
    try {
      result = await params.probe({
        input: probeInput.input,
        timeoutMs: params.timeoutMs,
        timeline: true,
        streamSelector: probeStreamSelectorFor(candidate.type),
      });
    } finally {
      await probeInput.cleanup();
    }
    const actualDurationSeconds = extractActualSegmentDurationSeconds(result, Boolean(segment.map));
    const streamMetadata = extractProbeStreamMetadata(result.streams);
    entries.push({
      kind: candidate.kind,
      mediaIndex: candidate.index,
      segmentIndex,
      originalSegmentIndex: segment.originalIndex,
      type: candidate.type,
      label: candidate.label,
      localPath,
      timelineStartSeconds: segment.timelineStartSeconds,
      timelineEndSeconds: segment.timelineEndSeconds,
      declaredDurationSeconds: segment.duration,
      actualDurationSeconds,
      durationDeltaSeconds: calculateDurationDelta(segment.duration, actualDurationSeconds),
      streamCount: Array.isArray(result.streams) ? result.streams.length : 0,
      codecName: streamMetadata.codecName,
      sampleRate: streamMetadata.sampleRate,
      channels: streamMetadata.channels,
      packetCount: result.timeline?.sampleCount,
      firstPtsTime: result.timeline?.firstPtsTime,
      lastPtsTime: result.timeline?.lastPtsTime,
      lastSampleDurationSeconds: result.timeline?.lastSampleDurationTime,
      firstPtsUs: secondsToMicroseconds(result.timeline?.firstPtsTime),
      lastPtsUs: secondsToMicroseconds(result.timeline?.lastPtsTime),
      lastSampleDurationUs: secondsToMicroseconds(result.timeline?.lastSampleDurationTime),
      keyframeCount: result.timeline?.keyframeCount,
      startsWithKeyframe: result.timeline?.startsWithKeyframe,
      maxKeyframeGapSeconds: result.timeline?.maxKeyframeGapSeconds,
      ok: result.ok,
      errors: result.errors,
    });
  }
  return entries;
}

export function buildAnalyzeCandidates(clone: StreamerCloneResult): StreamerAnalyzeCandidate[] {
  return [
    ...clone.variants.map((variant, index) => ({
      kind: "variant" as const,
      index,
      type: "VIDEO" as const,
      label: formatVariantLabel(variant),
      manifestPath: variant.manifestPath,
      rootPath: path.dirname(variant.manifestPath),
      segments: variant.segments,
    })),
    ...clone.renditions.map((rendition, index) => ({
      kind: "rendition" as const,
      index,
      type: renditionType(rendition.type),
      label: [
        rendition.type.toUpperCase(),
        rendition.groupId,
        rendition.name,
        rendition.channels ? `${rendition.channels}ch` : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" | ") || rendition.sourceUri,
      manifestPath: rendition.manifestPath,
      rootPath: path.dirname(rendition.manifestPath),
      segments: rendition.segments,
    })),
  ];
}

export function sampleAnalyzeSegmentIndices(
  segments: StreamerClonedSegment[],
  maxSegments: number,
  startSegment: number | undefined,
  segmentCount: number | undefined,
): number[] {
  const filteredIndexes = segments.flatMap((segment, index) => {
    if (startSegment === undefined && segmentCount === undefined) {
      return [index];
    }
    const windowStart = startSegment ?? 0;
    const windowEnd = segmentCount === undefined
      ? Number.POSITIVE_INFINITY
      : windowStart + segmentCount;
    return segment.originalIndex >= windowStart && segment.originalIndex < windowEnd
      ? [index]
      : [];
  });
  return sampleIndices(filteredIndexes.length, maxSegments)
    .map((position) => filteredIndexes[position])
    .filter((index): index is number => index !== undefined);
}

export async function prepareSegmentProbeInput(
  rootPath: string,
  segment: StreamerClonedSegment,
  segmentPath: string,
): Promise<{ input: string; cleanup(): Promise<void> }> {
  if (!segment.map) {
    return {
      input: segmentPath,
      cleanup: async () => undefined,
    };
  }

  const mapPath = path.join(rootPath, segment.map.localUri);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vhs-streamer-probe-"));
  const ext = path.extname(segment.localUri) || ".mp4";
  const tempPath = path.join(tempDir, `segment-with-init${ext === ".dash" ? ".mp4" : ext}`);

  try {
    const [initBytes, segmentBytes] = await Promise.all([
      fs.readFile(mapPath),
      fs.readFile(segmentPath),
    ]);
    await fs.writeFile(tempPath, Buffer.concat([initBytes, segmentBytes]));
    return {
      input: tempPath,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function probeStreamSelectorFor(type: MediaType): string {
  switch (type) {
    case "VIDEO":
      return "v:0";
    case "AUDIO":
      return "a:0";
    case "SUBTITLES":
      return "s:0";
  }
}

export function extractProbeStreamMetadata(streams: unknown[] | undefined): {
  codecName?: string;
  sampleRate?: number;
  channels?: number;
} {
  const stream = Array.isArray(streams) && streams[0] && typeof streams[0] === "object"
    ? streams[0] as Record<string, unknown>
    : undefined;
  if (!stream) {
    return {};
  }
  const sampleRate = typeof stream.sample_rate === "string" || typeof stream.sample_rate === "number"
    ? Number(stream.sample_rate)
    : undefined;
  const channels = typeof stream.channels === "string" || typeof stream.channels === "number"
    ? Number(stream.channels)
    : undefined;
  return {
    codecName: typeof stream.codec_name === "string" ? stream.codec_name : undefined,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : undefined,
    channels: Number.isFinite(channels) ? channels : undefined,
  };
}

export function extractActualSegmentDurationSeconds(
  result: ProbeResult,
  hasInitSegment: boolean,
): number | undefined {
  if (
    hasInitSegment &&
    typeof result.timeline?.firstPtsTime === "number" &&
    typeof result.timeline.lastPtsTime === "number"
  ) {
    const sampleDuration = result.timeline.lastSampleDurationTime ?? 0;
    const duration = result.timeline.lastPtsTime - result.timeline.firstPtsTime + sampleDuration;
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  }
  return extractProbeDurationSeconds(result.format);
}

export function secondsToMicroseconds(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 1_000_000)
    : undefined;
}

function calculateDurationDelta(
  declared?: number,
  actual?: number,
): number | undefined {
  return typeof declared === "number" && typeof actual === "number"
    ? actual - declared
    : undefined;
}

function sampleIndices(count: number, maxSamples: number): number[] {
  if (count <= 0 || maxSamples <= 0) {
    return [];
  }
  if (count <= maxSamples) {
    return Array.from({ length: count }, (_, index) => index);
  }

  const samples = new Set<number>([0, Math.floor((count - 1) / 2), count - 1]);
  if (maxSamples >= 4) samples.add(Math.floor(count / 3));
  if (maxSamples >= 5) samples.add(Math.floor((2 * count) / 3));
  return [...samples].sort((left, right) => left - right).slice(0, maxSamples);
}

function extractProbeDurationSeconds(format: unknown): number | undefined {
  if (!format || typeof format !== "object") {
    return undefined;
  }
  const duration = (format as { duration?: unknown }).duration;
  if (typeof duration !== "string" && typeof duration !== "number") {
    return undefined;
  }
  const value = Number(duration);
  return Number.isFinite(value) ? value : undefined;
}

function formatVariantLabel(variant: StreamerCloneResult["variants"][number]): string {
  const source = variant.variant;
  return [
    source?.resolution,
    typeof source?.bandwidth === "number" ? `${source.bandwidth}bps` : undefined,
    source?.codecs,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ") || source?.uri || variant.sourceUri;
}

function renditionType(type: string): "AUDIO" | "SUBTITLES" {
  const normalized = type.trim().toUpperCase();
  if (normalized === "AUDIO" || normalized === "SUBTITLES") {
    return normalized;
  }
  throw new Error(`unsupported rendition type "${type}"`);
}
