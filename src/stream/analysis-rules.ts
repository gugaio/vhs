import type {
  StreamerAvAlignmentSummary,
  StreamerClonedSegment,
  StreamerMediaAnalysisSummary,
  StreamerOriginAnalysisReport,
} from "./model.js";
import type { StreamerAnalyzeCandidate } from "./analysis-probe.js";
import { secondsToMicroseconds } from "./analysis-probe.js";

const DURATION_DELTA_WARN_SECONDS = 0.150;
const BOUNDARY_DELTA_WARN_SECONDS = 0.250;
const AUDIO_TIMESTAMP_DELTA_WARN_SECONDS = 0.050;
const AV_TIMELINE_DRIFT_WARN_SECONDS = 0.250;
const MAX_AV_TIMELINE_DRIFT_WINDOWS = 20;
const GOP_GAP_WARN_SECONDS = 3.000;

type AnalysisEntries = StreamerOriginAnalysisReport["entries"];

export function applyCandidateAnalysis(
  candidate: StreamerAnalyzeCandidate,
  entries: AnalysisEntries,
): void {
  applyBoundaryAnalysis(candidate, entries);
  applyAudioTimestampContinuityAnalysis(candidate, entries);
}

export function summarizeAnalysis(entries: AnalysisEntries): {
  media: StreamerMediaAnalysisSummary[];
  avAlignment: StreamerAvAlignmentSummary;
  issues: StreamerOriginAnalysisReport["issues"];
} {
  const media = buildMediaAnalysisSummaries(entries);
  const avAlignment = buildAvAlignmentSummary(entries);
  return {
    media,
    avAlignment,
    issues: buildAnalysisIssues(entries, media, avAlignment),
  };
}

function applyBoundaryAnalysis(
  candidate: StreamerAnalyzeCandidate,
  entries: AnalysisEntries,
): void {
  const sorted = [...entries].sort(compareMediaEntries);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (!previous || typeof current.firstPtsTime !== "number" || typeof previous.firstPtsTime !== "number") {
      current.boundaryStatus = "unknown";
      continue;
    }
    if (current.firstPtsTime <= previous.firstPtsTime) {
      current.boundaryStatus = "reset";
      continue;
    }

    const expectedStart =
      previous.firstPtsTime +
      sumDeclaredDurations(candidate.segments, previous.segmentIndex, current.segmentIndex);
    current.boundaryDeltaSeconds = current.firstPtsTime - expectedStart;
    current.boundaryStatus =
      Math.abs(current.boundaryDeltaSeconds) <= BOUNDARY_DELTA_WARN_SECONDS
        ? "ok"
        : "warn";
  }
}

function applyAudioTimestampContinuityAnalysis(
  candidate: StreamerAnalyzeCandidate,
  entries: AnalysisEntries,
): void {
  if (candidate.type !== "AUDIO") {
    return;
  }

  const sorted = [...entries].sort(compareMediaEntries);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (
      !previous ||
      current.segmentIndex !== previous.segmentIndex + 1 ||
      typeof current.firstPtsTime !== "number"
    ) {
      current.continuityStatus = "unknown";
      continue;
    }

    const expectedSeconds = calculateExpectedNextAudioPtsSeconds(previous, candidate.segments);
    if (typeof expectedSeconds !== "number") {
      current.continuityStatus = "unknown";
      continue;
    }

    const deltaSeconds = current.firstPtsTime - expectedSeconds;
    current.nextExpectedPtsUs = secondsToMicroseconds(expectedSeconds);
    current.nextActualPtsUs = secondsToMicroseconds(current.firstPtsTime);
    current.nextDeltaUs = secondsToMicroseconds(deltaSeconds);

    if (typeof previous.firstPtsTime === "number" && current.firstPtsTime <= previous.firstPtsTime) {
      current.continuityStatus = "reset";
    } else if (Math.abs(deltaSeconds) <= AUDIO_TIMESTAMP_DELTA_WARN_SECONDS) {
      current.continuityStatus = "ok";
    } else {
      current.continuityStatus = deltaSeconds > 0 ? "gap" : "overlap";
    }
  }
}

function calculateExpectedNextAudioPtsSeconds(
  previous: AnalysisEntries[number],
  segments: StreamerClonedSegment[],
): number | undefined {
  if (typeof previous.lastPtsTime === "number" && typeof previous.lastSampleDurationSeconds === "number") {
    return previous.lastPtsTime + previous.lastSampleDurationSeconds;
  }
  if (typeof previous.firstPtsTime !== "number") {
    return undefined;
  }
  const duration =
    typeof previous.actualDurationSeconds === "number"
      ? previous.actualDurationSeconds
      : segments[previous.segmentIndex]?.duration;
  return typeof duration === "number" ? previous.firstPtsTime + duration : undefined;
}

function sumDeclaredDurations(
  segments: StreamerClonedSegment[],
  fromIndex: number,
  toIndex: number,
): number {
  let sum = 0;
  for (let index = fromIndex; index < toIndex; index += 1) {
    sum += segments[index]?.duration ?? 0;
  }
  return sum;
}

function buildMediaAnalysisSummaries(entries: AnalysisEntries): StreamerMediaAnalysisSummary[] {
  const groups = new Map<string, AnalysisEntries>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.mediaIndex}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const durationDeltas = group.map((entry) => entry.durationDeltaSeconds);
    const boundaryDeltas = group.map((entry) => entry.boundaryDeltaSeconds);
    const maxKeyframeGapSeconds = maxOptional(group.map((entry) => entry.maxKeyframeGapSeconds));
    const startsWithKeyframeFailures = group.filter((entry) => entry.startsWithKeyframe === false).length;
    return {
      kind: first.kind,
      mediaIndex: first.mediaIndex,
      type: first.type,
      label: first.label,
      sampledSegments: group.length,
      durationDeltaMaxSeconds: maxAbsOptional(durationDeltas),
      durationDeltaAverageSeconds: averageAbsOptional(durationDeltas),
      boundaryStatus: summarizeBoundaryStatus(group),
      boundaryDeltaMaxSeconds: maxAbsOptional(boundaryDeltas),
      gopStatus: summarizeGopStatus(first.type, maxKeyframeGapSeconds, startsWithKeyframeFailures),
      maxKeyframeGapSeconds,
      startsWithKeyframeFailures: first.type === "VIDEO" ? startsWithKeyframeFailures : undefined,
    };
  });
}

function buildAvAlignmentSummary(entries: AnalysisEntries): StreamerAvAlignmentSummary {
  const videoEntries = entries.filter((entry) => entry.type === "VIDEO" && entry.kind === "variant");
  const audioEntries = entries.filter((entry) => entry.type === "AUDIO");
  const durationDeltas: number[] = [];
  const startPtsDeltas: number[] = [];
  const notes = new Set<string>();
  const timelineDriftWindows = buildAvTimelineDriftWindows(videoEntries, audioEntries);

  for (const video of videoEntries) {
    for (const audio of audioEntries.filter((entry) => entry.segmentIndex === video.segmentIndex)) {
      if (typeof video.actualDurationSeconds === "number" && typeof audio.actualDurationSeconds === "number") {
        durationDeltas.push(Math.abs(video.actualDurationSeconds - audio.actualDurationSeconds));
      }
      if (typeof video.firstPtsTime === "number" && typeof audio.firstPtsTime === "number") {
        const delta = Math.abs(video.firstPtsTime - audio.firstPtsTime);
        if (delta <= 2) {
          startPtsDeltas.push(delta);
        } else {
          notes.add("audio/video PTS clocks look different or reset per segment");
        }
      }
    }
  }

  const maxDurationDeltaSeconds = maxOptional(durationDeltas);
  const maxStartPtsDeltaSeconds = maxOptional(startPtsDeltas);
  const comparedPairs = durationDeltas.length;
  if (comparedPairs === 0) notes.add("no matching audio/video sampled segments");
  if (startPtsDeltas.length === 0) notes.add("PTS start alignment unavailable");

  const maxTimelineDriftSeconds = maxOptional(timelineDriftWindows.map(maxAvTimelineDrift));
  if (timelineDriftWindows.length === 0 && audioEntries.length > 0 && videoEntries.length > 0) {
    notes.add("audio/video manifest timeline windows unavailable");
  }

  const status =
    comparedPairs === 0 && timelineDriftWindows.length === 0
      ? "unknown"
      : (maxDurationDeltaSeconds !== undefined &&
          maxDurationDeltaSeconds > DURATION_DELTA_WARN_SECONDS) ||
        (maxTimelineDriftSeconds !== undefined &&
          maxTimelineDriftSeconds > AV_TIMELINE_DRIFT_WARN_SECONDS)
        ? "warn"
        : "ok";
  return {
    status,
    comparedPairs,
    maxDurationDeltaSeconds,
    maxStartPtsDeltaSeconds,
    comparedTimelineWindows: timelineDriftWindows.length,
    maxTimelineDriftSeconds,
    timelineDriftWindows: timelineDriftWindows.slice(0, MAX_AV_TIMELINE_DRIFT_WINDOWS),
    notes: [...notes],
  };
}

function buildAvTimelineDriftWindows(
  videoEntries: AnalysisEntries,
  audioEntries: AnalysisEntries,
): NonNullable<StreamerAvAlignmentSummary["timelineDriftWindows"]> {
  const sortedVideo = videoEntries.filter(hasTimelineWindow).sort(compareMediaEntries);
  const audioGroups = groupEntriesByMediaIndex(audioEntries.filter(hasTimelineWindow));
  const windows: NonNullable<StreamerAvAlignmentSummary["timelineDriftWindows"]> = [];

  for (const video of sortedVideo) {
    for (const [audioMediaIndex, group] of audioGroups) {
      const audio = group.find((entry) => entry.segmentIndex === video.segmentIndex);
      if (!audio || !hasTimelineWindow(audio)) continue;

      const videoDurationSeconds = video.timelineEndSeconds - video.timelineStartSeconds;
      const audioDurationSeconds = audio.timelineEndSeconds - audio.timelineStartSeconds;
      const startDeltaSeconds = audio.timelineStartSeconds - video.timelineStartSeconds;
      const endDeltaSeconds = audio.timelineEndSeconds - video.timelineEndSeconds;
      const durationDeltaSeconds = audioDurationSeconds - videoDurationSeconds;
      const actualDurationDeltaSeconds =
        typeof video.actualDurationSeconds === "number" && typeof audio.actualDurationSeconds === "number"
          ? audio.actualDurationSeconds - video.actualDurationSeconds
          : undefined;
      const maxDriftSeconds = Math.max(
        Math.abs(startDeltaSeconds),
        Math.abs(endDeltaSeconds),
        Math.abs(durationDeltaSeconds),
        Math.abs(actualDurationDeltaSeconds ?? 0),
      );

      windows.push({
        audioMediaIndex,
        videoSegmentIndex: video.segmentIndex,
        audioSegmentIndex: audio.segmentIndex,
        timelineStartSeconds: video.timelineStartSeconds,
        timelineEndSeconds: video.timelineEndSeconds,
        videoDurationSeconds,
        audioDurationSeconds,
        startDeltaSeconds,
        endDeltaSeconds,
        durationDeltaSeconds,
        actualDurationDeltaSeconds,
        status: maxDriftSeconds > AV_TIMELINE_DRIFT_WARN_SECONDS ? "warn" : "ok",
      });
    }
  }
  return windows.sort((left, right) => maxAvTimelineDrift(right) - maxAvTimelineDrift(left));
}

function groupEntriesByMediaIndex(entries: AnalysisEntries): Map<number, AnalysisEntries> {
  const groups = new Map<number, AnalysisEntries>();
  for (const entry of [...entries].sort(compareMediaEntries)) {
    groups.set(entry.mediaIndex, [...(groups.get(entry.mediaIndex) ?? []), entry]);
  }
  return groups;
}

function maxAvTimelineDrift(
  window: NonNullable<StreamerAvAlignmentSummary["timelineDriftWindows"]>[number],
): number {
  return Math.max(
    Math.abs(window.startDeltaSeconds),
    Math.abs(window.endDeltaSeconds),
    Math.abs(window.durationDeltaSeconds),
    Math.abs(window.actualDurationDeltaSeconds ?? 0),
  );
}

function hasTimelineWindow(
  entry: AnalysisEntries[number],
): entry is AnalysisEntries[number] & {
  timelineStartSeconds: number;
  timelineEndSeconds: number;
} {
  return typeof entry.timelineStartSeconds === "number" &&
    typeof entry.timelineEndSeconds === "number";
}

function compareMediaEntries(
  left: AnalysisEntries[number],
  right: AnalysisEntries[number],
): number {
  return left.segmentIndex - right.segmentIndex;
}

function buildAnalysisIssues(
  entries: AnalysisEntries,
  media: StreamerMediaAnalysisSummary[],
  avAlignment: StreamerAvAlignmentSummary,
): StreamerOriginAnalysisReport["issues"] {
  const issues: StreamerOriginAnalysisReport["issues"] = [];

  for (const entry of entries) {
    if (!entry.ok) {
      issues.push({
        severity: "error",
        code: "segment_probe_failed",
        summary: `ffprobe failed for ${entry.kind}[${entry.mediaIndex}] seg[${entry.segmentIndex}]`,
        evidence: entry.errors.length > 0 ? entry.errors : [entry.localPath],
      });
    }
    if (typeof entry.durationDeltaSeconds === "number" &&
        Math.abs(entry.durationDeltaSeconds) > DURATION_DELTA_WARN_SECONDS) {
      issues.push({
        severity: "warning",
        code: "duration_delta_high",
        summary: `segment duration differs from EXTINF by ${entry.durationDeltaSeconds.toFixed(3)}s`,
        evidence: [
          `${entry.kind}[${entry.mediaIndex}] seg[${entry.segmentIndex}]`,
          `declared=${entry.declaredDurationSeconds?.toFixed(3) ?? "n/a"}s`,
          `actual=${entry.actualDurationSeconds?.toFixed(3) ?? "n/a"}s`,
        ],
      });
    }
    if (entry.boundaryStatus === "warn" && typeof entry.boundaryDeltaSeconds === "number") {
      issues.push({
        severity: "warning",
        code: entry.boundaryDeltaSeconds > 0 ? "segment_boundary_gap" : "segment_boundary_overlap",
        summary: `segment boundary delta is ${entry.boundaryDeltaSeconds.toFixed(3)}s`,
        evidence: [
          `${entry.kind}[${entry.mediaIndex}] seg[${entry.segmentIndex}]`,
          `boundaryDelta=${entry.boundaryDeltaSeconds.toFixed(3)}s`,
        ],
      });
    }
    if (entry.type === "AUDIO" &&
        (entry.continuityStatus === "gap" || entry.continuityStatus === "overlap") &&
        typeof entry.nextDeltaUs === "number") {
      issues.push({
        severity: "warning",
        code: "audio_timestamp_discontinuity",
        summary: `audio timestamp ${entry.continuityStatus} is ${formatMicrosecondsAsMs(entry.nextDeltaUs)}`,
        evidence: [
          `${entry.kind}[${entry.mediaIndex}] seg[${entry.segmentIndex - 1}] -> seg[${entry.segmentIndex}]`,
          `expected=${entry.nextExpectedPtsUs ?? "n/a"}us`,
          `actual=${entry.nextActualPtsUs ?? "n/a"}us`,
          `delta=${formatMicrosecondsAsMs(entry.nextDeltaUs)}`,
        ],
      });
    }
    if (entry.type === "VIDEO" && entry.startsWithKeyframe === false) {
      issues.push({
        severity: "warning",
        code: "segment_not_keyframe_aligned",
        summary: "video segment does not start with a keyframe",
        evidence: [`${entry.kind}[${entry.mediaIndex}] seg[${entry.segmentIndex}]`],
      });
    }
  }

  for (const item of media) {
    if (item.gopStatus === "warn") {
      issues.push({
        severity: "warning",
        code: "gop_unstable",
        summary: `video GOP looks unstable for ${item.kind}[${item.mediaIndex}]`,
        evidence: [
          `maxKeyframeGap=${item.maxKeyframeGapSeconds?.toFixed(3) ?? "n/a"}s`,
          `startsWithKeyframeFailures=${item.startsWithKeyframeFailures ?? 0}`,
          item.label,
        ],
      });
    }
  }

  if (avAlignment.status === "warn" &&
      typeof avAlignment.maxDurationDeltaSeconds === "number") {
    issues.push({
      severity: "warning",
      code: "av_duration_drift",
      summary: `audio/video sampled segment duration delta reached ${avAlignment.maxDurationDeltaSeconds.toFixed(3)}s`,
      evidence: [
        `comparedPairs=${avAlignment.comparedPairs}`,
        `maxDurationDelta=${avAlignment.maxDurationDeltaSeconds.toFixed(3)}s`,
      ],
    });
  }

  const timelineDriftWindows =
    avAlignment.timelineDriftWindows?.filter((window) => window.status === "warn") ?? [];
  if (timelineDriftWindows.length > 0 &&
      typeof avAlignment.maxTimelineDriftSeconds === "number") {
    issues.push({
      severity: "warning",
      code: "av_timeline_window_drift",
      summary: `audio/video manifest timeline drift reached ${avAlignment.maxTimelineDriftSeconds.toFixed(3)}s`,
      evidence: [
        `comparedWindows=${avAlignment.comparedTimelineWindows ?? timelineDriftWindows.length}`,
        `maxTimelineDrift=${avAlignment.maxTimelineDriftSeconds.toFixed(3)}s`,
        ...timelineDriftWindows.slice(0, 3).map((window) =>
          `video seg[${window.videoSegmentIndex}] audio[${window.audioMediaIndex}] seg[${window.audioSegmentIndex}] ` +
          `startDelta=${window.startDeltaSeconds.toFixed(3)}s ` +
          `endDelta=${window.endDeltaSeconds.toFixed(3)}s ` +
          `durationDelta=${window.durationDeltaSeconds.toFixed(3)}s`,
        ),
      ],
    });
  }
  return issues;
}

function summarizeBoundaryStatus(
  entries: AnalysisEntries,
): "ok" | "warn" | "reset" | "unknown" {
  const statuses = entries
    .map((entry) => entry.boundaryStatus)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (statuses.includes("warn")) return "warn";
  if (statuses.includes("reset")) return "reset";
  if (statuses.includes("ok")) return "ok";
  return "unknown";
}

function summarizeGopStatus(
  type: "AUDIO" | "SUBTITLES" | "VIDEO",
  maxKeyframeGapSeconds: number | undefined,
  startsWithKeyframeFailures: number,
): "ok" | "warn" | "unknown" | undefined {
  if (type !== "VIDEO") return undefined;
  if (startsWithKeyframeFailures > 0 ||
      (maxKeyframeGapSeconds !== undefined && maxKeyframeGapSeconds > GOP_GAP_WARN_SECONDS)) {
    return "warn";
  }
  return maxKeyframeGapSeconds === undefined ? "unknown" : "ok";
}

function maxOptional(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

function maxAbsOptional(values: Array<number | undefined>): number | undefined {
  return maxOptional(values.map((value) =>
    typeof value === "number" ? Math.abs(value) : undefined,
  ));
}

function averageAbsOptional(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return filtered.length === 0
    ? undefined
    : filtered.reduce((sum, value) => sum + Math.abs(value), 0) / filtered.length;
}

function formatMicrosecondsAsMs(value: number): string {
  return `${(value / 1_000).toFixed(3)}ms`;
}
