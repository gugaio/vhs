import type { DashInspectResult, HlsInspectResult } from "../inspect.js";

export type SegmentWindowRequest = {
  startSeconds: number;
  durationSeconds: number;
  startSegment?: number;
  segmentCount?: number;
};

export function selectHlsSegmentWindow(
  inspected: HlsInspectResult,
  request: SegmentWindowRequest,
): Array<{
  index: number;
  segment: HlsInspectResult["segments"][number];
  timelineStartSeconds: number;
  timelineEndSeconds: number;
}> {
  return selectSegmentWindow(
    inspected.segments,
    request,
    inspected.targetDuration ?? 0,
  );
}

export function selectDashSegmentWindow(
  representation: DashInspectResult["representations"][number],
  request: SegmentWindowRequest,
): Array<{
  index: number;
  segment: DashInspectResult["representations"][number]["segments"][number];
  timelineStartSeconds: number;
  timelineEndSeconds: number;
}> {
  return selectSegmentWindow(representation.segments, request, 0);
}

function selectSegmentWindow<T extends { duration?: number }>(
  segments: T[],
  request: SegmentWindowRequest,
  fallbackDuration: number,
): Array<{
  index: number;
  segment: T;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
}> {
  const selected: Array<{
    index: number;
    segment: T;
    timelineStartSeconds: number;
    timelineEndSeconds: number;
  }> = [];
  let timelineEndSeconds = 0;
  let firstIncludedStart: number | undefined;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const timelineStartSeconds = timelineEndSeconds;
    timelineEndSeconds += segment.duration ?? fallbackDuration;

    if (request.startSegment !== undefined && index < request.startSegment) {
      continue;
    }
    if (request.startSegment === undefined && timelineEndSeconds <= request.startSeconds) {
      continue;
    }

    firstIncludedStart ??= timelineStartSeconds;
    const windowStart = request.startSegment === undefined
      ? request.startSeconds
      : firstIncludedStart;
    const windowEnd = windowStart + request.durationSeconds;

    if (request.segmentCount !== undefined && selected.length >= request.segmentCount) {
      break;
    }
    if (
      request.segmentCount === undefined &&
      timelineStartSeconds >= windowEnd &&
      selected.length > 0
    ) {
      break;
    }

    selected.push({ index, segment, timelineStartSeconds, timelineEndSeconds });
    if (request.segmentCount === undefined && timelineEndSeconds >= windowEnd) {
      break;
    }
  }

  return selected;
}
