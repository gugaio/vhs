import type { MediaInspector } from "../inspect.js";
import type {
  StreamerAnalyzeOptions,
  StreamerOriginAnalysisReport,
} from "./model.js";
import { analyzeCandidate, buildAnalyzeCandidates } from "./analysis-probe.js";
import { applyCandidateAnalysis, summarizeAnalysis } from "./analysis-rules.js";
import { normalizeAnalyzeOptions } from "./options.js";
import type { StreamerOriginStore } from "./origin-store.js";

type ProbeService = Pick<MediaInspector, "probe">;

export async function analyzeOrigin(
  store: StreamerOriginStore,
  inspect: Partial<ProbeService>,
  originId: string,
  options: StreamerAnalyzeOptions = {},
): Promise<StreamerOriginAnalysisReport> {
  if (!inspect.probe) {
    throw new Error("streamer analyze requires ffprobe support in MediaInspector");
  }

  const clone = await store.load(originId);
  const normalized = normalizeAnalyzeOptions(options);
  const candidates = buildAnalyzeCandidates(clone).slice(0, normalized.maxMediaPlaylists);
  const entries: StreamerOriginAnalysisReport["entries"] = [];

  for (const candidate of candidates) {
    const candidateEntries = await analyzeCandidate({
      candidate,
      probe: inspect.probe,
      timeoutMs: normalized.timeoutMs,
      maxSegments: normalized.maxSegmentsPerPlaylist,
      startSegment: normalized.startSegment,
      segmentCount: normalized.segmentCount,
    });
    applyCandidateAnalysis(candidate, candidateEntries);
    entries.push(...candidateEntries);
  }

  const okSegments = entries.filter((entry) => entry.ok).length;
  const { media, avAlignment, issues } = summarizeAnalysis(entries);
  return {
    originId: clone.id,
    ok: entries.every((entry) => entry.ok) &&
      !issues.some((issue) => issue.severity === "error"),
    sampledMediaPlaylists: candidates.length,
    totalMediaPlaylists: clone.variantCount + clone.renditionCount,
    sampledSegments: entries.length,
    okSegments,
    failedSegments: entries.length - okSegments,
    media,
    avAlignment,
    issues,
    entries,
  };
}
