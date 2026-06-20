import type { ManifestSeverity } from "../manifest.js";

export type StreamerProbeOptions = {
  /** Timeout de ffprobe por playlist amostrada. */
  timeoutMs?: number;
  /** Quantidade maxima de playlists de media amostradas (variants + renditions). */
  maxMediaPlaylists?: number;
};

export type StreamerMediaProbeEntry = {
  kind: "variant" | "rendition";
  index: number;
  type: "AUDIO" | "SUBTITLES" | "VIDEO";
  label: string;
  manifestPath: string;
  ok: boolean;
  streamCount: number;
  errors: string[];
};

export type StreamerOriginProbeReport = {
  originId: string;
  ok: boolean;
  sampledMediaPlaylists: number;
  totalMediaPlaylists: number;
  okCount: number;
  failedCount: number;
  entries: StreamerMediaProbeEntry[];
};

export type StreamerAnalyzeOptions = {
  /** Timeout de ffprobe por segmento amostrado. */
  timeoutMs?: number;
  /** Quantidade maxima de playlists de media consideradas (variants + renditions). */
  maxMediaPlaylists?: number;
  /** Quantidade maxima de segmentos amostrados por playlist (first/middle/last). */
  maxSegmentsPerPlaylist?: number;
  /** Indice zero-based do primeiro segmento original a analisar. */
  startSegment?: number;
  /** Quantidade de segmentos originais a analisar a partir de startSegment. */
  segmentCount?: number;
  /** Analisa todos os segmentos das playlists consideradas. */
  full?: boolean;
};

export type StreamerTimelineContinuityStatus = "ok" | "gap" | "overlap" | "reset" | "unknown";

export type StreamerSegmentAnalysisEntry = {
  kind: "variant" | "rendition";
  mediaIndex: number;
  segmentIndex: number;
  originalSegmentIndex?: number;
  type: "AUDIO" | "SUBTITLES" | "VIDEO";
  label: string;
  localPath: string;
  timelineStartSeconds?: number;
  timelineEndSeconds?: number;
  declaredDurationSeconds?: number;
  actualDurationSeconds?: number;
  durationDeltaSeconds?: number;
  streamCount: number;
  codecName?: string;
  sampleRate?: number;
  channels?: number;
  packetCount?: number;
  firstPtsTime?: number;
  lastPtsTime?: number;
  lastSampleDurationSeconds?: number;
  firstPtsUs?: number;
  lastPtsUs?: number;
  lastSampleDurationUs?: number;
  nextExpectedPtsUs?: number;
  nextActualPtsUs?: number;
  nextDeltaUs?: number;
  continuityStatus?: StreamerTimelineContinuityStatus;
  boundaryDeltaSeconds?: number;
  boundaryStatus?: "ok" | "warn" | "reset" | "unknown";
  keyframeCount?: number;
  startsWithKeyframe?: boolean;
  maxKeyframeGapSeconds?: number;
  ok: boolean;
  errors: string[];
};

export type StreamerMediaAnalysisSummary = {
  kind: "variant" | "rendition";
  mediaIndex: number;
  type: "AUDIO" | "SUBTITLES" | "VIDEO";
  label: string;
  sampledSegments: number;
  durationDeltaMaxSeconds?: number;
  durationDeltaAverageSeconds?: number;
  boundaryStatus: "ok" | "warn" | "reset" | "unknown";
  boundaryDeltaMaxSeconds?: number;
  gopStatus?: "ok" | "warn" | "unknown";
  maxKeyframeGapSeconds?: number;
  startsWithKeyframeFailures?: number;
};

export type StreamerAvAlignmentSummary = {
  status: "ok" | "warn" | "unknown";
  comparedPairs: number;
  maxDurationDeltaSeconds?: number;
  maxStartPtsDeltaSeconds?: number;
  comparedTimelineWindows?: number;
  maxTimelineDriftSeconds?: number;
  timelineDriftWindows?: StreamerAvTimelineDriftWindow[];
  notes: string[];
};

export type StreamerAvTimelineDriftWindow = {
  audioMediaIndex: number;
  videoSegmentIndex: number;
  audioSegmentIndex: number;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number;
  startDeltaSeconds: number;
  endDeltaSeconds: number;
  durationDeltaSeconds: number;
  actualDurationDeltaSeconds?: number;
  status: "ok" | "warn";
};

export type StreamerAnalysisIssue = {
  severity: ManifestSeverity;
  code: string;
  summary: string;
  evidence: string[];
};

export type StreamerOriginAnalysisReport = {
  originId: string;
  ok: boolean;
  sampledMediaPlaylists: number;
  totalMediaPlaylists: number;
  sampledSegments: number;
  okSegments: number;
  failedSegments: number;
  media: StreamerMediaAnalysisSummary[];
  avAlignment: StreamerAvAlignmentSummary;
  issues: StreamerAnalysisIssue[];
  entries: StreamerSegmentAnalysisEntry[];
};
