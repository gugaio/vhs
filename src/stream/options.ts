import { clampInteger, clampNumber } from "./support.js";
import type {
  StreamerAnalyzeOptions,
  StreamerCloneInput,
  StreamerProbeOptions,
} from "./model.js";

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEGMENT_TIMEOUT_MS = 60_000;
const DEFAULT_SEGMENT_RETRIES = 2;
const DEFAULT_MAX_SEGMENTS = 200;
export const MAX_CLONE_INSPECT_SEGMENTS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PROBE_MEDIA_PLAYLISTS = 4;
const DEFAULT_MAX_ANALYZE_SEGMENTS_PER_PLAYLIST = 3;

export type NormalizedCloneOptions = {
  durationSeconds: number;
  startSeconds: number;
  startSegment?: number;
  segmentCount?: number;
  timeoutMs: number;
  segmentTimeoutMs: number;
  segmentRetries: number;
  maxSegments: number;
};

export function normalizeCloneOptions(input: StreamerCloneInput): NormalizedCloneOptions {
  const startSegment = optionalInteger(input.startSegment, 0, MAX_CLONE_INSPECT_SEGMENTS - 1);
  const segmentCount = optionalInteger(input.segmentCount, 1, MAX_CLONE_INSPECT_SEGMENTS);
  const requestedMaxSegments = clampInteger(
    input.maxSegments,
    DEFAULT_MAX_SEGMENTS,
    1,
    MAX_CLONE_INSPECT_SEGMENTS,
  );
  const requiredForWindow =
    startSegment !== undefined
      ? startSegment + (segmentCount ?? DEFAULT_MAX_SEGMENTS)
      : segmentCount;

  return {
    durationSeconds: clampNumber(input.durationSeconds, DEFAULT_DURATION_SECONDS, 1, 60 * 60),
    startSeconds: clampNumber(input.startSeconds, 0, 0, 24 * 60 * 60),
    startSegment,
    segmentCount,
    timeoutMs: clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000),
    segmentTimeoutMs: clampNumber(
      input.segmentTimeoutMs,
      DEFAULT_SEGMENT_TIMEOUT_MS,
      1_000,
      5 * 60_000,
    ),
    segmentRetries: clampInteger(input.segmentRetries, DEFAULT_SEGMENT_RETRIES, 0, 5),
    maxSegments:
      requiredForWindow === undefined
        ? requestedMaxSegments
        : Math.min(MAX_CLONE_INSPECT_SEGMENTS, Math.max(requestedMaxSegments, requiredForWindow)),
  };
}

export function normalizeProbeOptions(options: StreamerProbeOptions): {
  timeoutMs: number;
  maxMediaPlaylists: number;
} {
  return {
    timeoutMs: clampNumber(options.timeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 1_000, 120_000),
    maxMediaPlaylists: clampInteger(
      options.maxMediaPlaylists,
      DEFAULT_MAX_PROBE_MEDIA_PLAYLISTS,
      1,
      32,
    ),
  };
}

export function normalizeAnalyzeOptions(options: StreamerAnalyzeOptions): {
  timeoutMs: number;
  startSegment?: number;
  segmentCount?: number;
  maxMediaPlaylists: number;
  maxSegmentsPerPlaylist: number;
} {
  return {
    ...normalizeProbeOptions(options),
    startSegment: optionalInteger(options.startSegment, 0, MAX_CLONE_INSPECT_SEGMENTS - 1),
    segmentCount: optionalInteger(options.segmentCount, 1, MAX_CLONE_INSPECT_SEGMENTS),
    maxSegmentsPerPlaylist: options.full
      ? Number.POSITIVE_INFINITY
      : clampInteger(
          options.maxSegmentsPerPlaylist,
          DEFAULT_MAX_ANALYZE_SEGMENTS_PER_PLAYLIST,
          1,
          8,
        ),
  };
}

function optionalInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(Math.max(min, Math.min(max, value)));
}
