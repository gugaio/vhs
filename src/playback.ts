import type { ManifestSeverity } from "./manifest.js";
import { deriveHlsJsIssues, parseHlsJsLogText } from "./hlsjs.js";

export type PlaybackEngine = "generic" | "avplayer" | "exoplayer" | "hlsjs" | "shaka";
export type PlaybackEventCategory = "lifecycle" | "buffer" | "network" | "abr" | "drm" | "quality" | "error" | "user";
export type PlaybackEvent = {
  atMs: number;
  name: string;
  category: PlaybackEventCategory;
  detail?: string;
  fatal?: boolean;
  data?: Record<string, unknown>;
};
export type PlaybackInput = {
  player: PlaybackEngine;
  source?: string;
  streamUrl?: string;
  logText?: string;
  events?: PlaybackEvent[];
};
export type PlaybackIssue = {
  code: string;
  severity: ManifestSeverity;
  summary: string;
  evidence: string[];
};
export type PlaybackReport = {
  ok: boolean;
  player: PlaybackEngine;
  source?: string;
  streamUrl?: string;
  summary: string;
  metrics: { eventCount: number; errorCount: number; fatalErrorCount: number; rebufferCount: number; startupTimeMs?: number };
  issues: PlaybackIssue[];
  recommendations: string[];
};

export class PlaybackTriageService {
  analyzeSession(input: PlaybackInput): PlaybackReport {
    const events = normalizePlaybackEvents(input).sort((left, right) => left.atMs - right.atMs);
    const issues: PlaybackIssue[] = [];
    const errorEvents = events.filter((event) => event.category === "error");
    const fatalEvents = errorEvents.filter((event) => event.fatal);
    const rebufferEvents = events.filter((event) => isRebufferEvent(event));
    const startupTimeMs = inferStartupTimeMs(events);

    if (fatalEvents.length > 0) {
      issues.push({
        code: "fatal_error",
        severity: "error",
        summary: `Sessao teve ${fatalEvents.length} erro(s) fatal(is) de playback.`,
        evidence: fatalEvents.slice(0, 3).map((event) => formatEventEvidence(event)),
      });
    }

    if (rebufferEvents.length >= 2) {
      issues.push({
        code: "rebuffering",
        severity: rebufferEvents.length >= 4 ? "error" : "warning",
        summary: `Sessao teve ${rebufferEvents.length} eventos de rebuffer/stall.`,
        evidence: rebufferEvents.slice(0, 4).map((event) => formatEventEvidence(event)),
      });
    }

    if (typeof startupTimeMs === "number" && startupTimeMs > 3000) {
      issues.push({
        code: "slow_startup",
        severity: startupTimeMs > 8000 ? "error" : "warning",
        summary: `Startup do playback levou ${startupTimeMs} ms.`,
        evidence: [`first_playing_at=${startupTimeMs}ms`],
      });
    }

    issues.push(...derivePlayerSpecificIssues(input.player, events));

    if (issues.length === 0 && errorEvents.length === 0) {
      issues.push({
        code: "clean_session",
        severity: "info",
        summary: "Sessao sem sinais fortes de erro ou rebuffer relevante.",
        evidence: [`events=${events.length}`, ...(input.logText ? [`lines=${countNonEmptyLines(input.logText)}`] : [])],
      });
    }

    return {
      ok: !issues.some((issue) => issue.severity === "error"),
      player: input.player,
      source: input.source,
      streamUrl: input.streamUrl,
      summary: buildSummary(input.player, issues),
      metrics: {
        eventCount: events.length,
        errorCount: errorEvents.length,
        fatalErrorCount: fatalEvents.length,
        rebufferCount: rebufferEvents.length,
        startupTimeMs,
      },
      issues,
      recommendations: buildRecommendations(input.player, issues),
    };
  }
}

function normalizePlaybackEvents(input: PlaybackInput): PlaybackEvent[] {
  const structured = Array.isArray(input.events) ? input.events : [];
  if (structured.length > 0) {
    return structured;
  }
  if (!input.logText?.trim()) {
    return [];
  }
  if (input.player === "hlsjs") {
    return parseHlsJsLogText(input.logText);
  }
  return parseLogTextToEvents(input.logText);
}

function derivePlayerSpecificIssues(
  player: PlaybackInput["player"],
  events: PlaybackEvent[],
): PlaybackIssue[] {
  if (player === "hlsjs") {
    return deriveHlsJsIssues(events);
  }
  return [];
}

function parseLogTextToEvents(logText: string): PlaybackEvent[] {
  const lines = logText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseLogLine(line, index));
}

function parseLogLine(line: string, index: number): PlaybackEvent {
  const lower = line.toLowerCase();
  const atMs = inferTimestampMs(line, index);
  const category = inferCategory(lower);
  const fatal = /\bfatal\b|\bunrecoverable\b/.test(lower);
  const name = inferEventName(lower);
  return {
    atMs,
    name,
    category,
    fatal,
    detail: line,
  };
}

function inferTimestampMs(line: string, index: number): number {
  const match =
    line.match(/\b(\d+(?:\.\d+)?)\s*ms\b/i) ||
    line.match(/\bt=(\d+(?:\.\d+)?)\b/i) ||
    line.match(/\bpts[:=]\s*(\d+(?:\.\d+)?)\b/i);
  if (!match) {
    return index * 1000;
  }
  const value = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(value) ? Math.round(value) : index * 1000;
}

function inferCategory(lower: string): PlaybackEvent["category"] {
  if (/\bfatal\b|\bunrecoverable\b|\berror\b|\bexception\b|\bfail(?:ed|ure)?\b/.test(lower)) {
    return "error";
  }
  if (/\bdrm\b|\blicense\b|\bwidevine\b|\bfairplay\b/.test(lower)) {
    return "drm";
  }
  if (/\b404\b|\btimeout\b|\bnetwork\b|\bfrag\b|\bmanifest\b|\bsegment\b|\bhttp\b/.test(lower)) {
    return "network";
  }
  if (/\bstall\b|\brebuffer\b|\bbuffer\b/.test(lower)) {
    return "buffer";
  }
  if (/\blevel\b|\bbitrate\b|\babr\b|\bquality\b|\btrack\b/.test(lower)) {
    return "abr";
  }
  if (/\bplay\b|\bready\b|\bloaded\b|\bstart\b|\bfirst frame\b/.test(lower)) {
    return "lifecycle";
  }
  return "quality";
}

function inferEventName(lower: string): string {
  if (lower.includes("fatal")) return "fatal_error";
  if (lower.includes("rebuffer")) return "rebuffer_start";
  if (lower.includes("stall")) return "buffer_stall";
  if (lower.includes("buffer")) return "buffer_event";
  if (lower.includes("playing")) return "playing";
  if (lower.includes("first frame")) return "first_frame";
  if (lower.includes("ready")) return "ready";
  if (lower.includes("manifest")) return "manifest_event";
  if (lower.includes("segment") || lower.includes("frag")) return "segment_event";
  if (lower.includes("license") || lower.includes("drm")) return "drm_event";
  if (lower.includes("error")) return "error";
  return "log_line";
}

function isRebufferEvent(event: PlaybackEvent): boolean {
  const name = event.name.toLowerCase();
  return (
    event.category === "buffer" ||
    name.includes("rebuffer") ||
    name.includes("stall") ||
    name.includes("buffer_empty")
  );
}

function inferStartupTimeMs(events: PlaybackEvent[]): number | undefined {
  const playingEvent = events.find((event) => {
    const name = event.name.toLowerCase();
    return name.includes("playing") || name.includes("first_frame") || name.includes("ready");
  });
  return playingEvent?.atMs;
}

function formatEventEvidence(event: PlaybackEvent): string {
  return `${event.atMs}ms:${event.name}${event.detail ? `:${event.detail}` : ""}`;
}

function buildSummary(player: PlaybackInput["player"], issues: PlaybackIssue[]): string {
  const highestSeverity = issues.some((issue) => issue.severity === "error")
    ? "erro"
    : issues.some((issue) => issue.severity === "warning")
      ? "alerta"
      : "limpa";
  return `Analise de playback para ${player}: sessao classificada como ${highestSeverity}.`;
}

function buildRecommendations(
  player: PlaybackInput["player"],
  issues: PlaybackIssue[],
): string[] {
  const recommendations = new Set<string>();
  if (issues.some((issue) => issue.code === "fatal_error")) {
    recommendations.add("Correlacionar erro fatal com manifesto, segmentos e resposta HTTP do stream.");
  }
  if (issues.some((issue) => issue.code === "rebuffering")) {
    recommendations.add("Inspecionar ladder ABR, latencia de segmento e oscilacao de bitrate.");
  }
  if (issues.some((issue) => issue.code === "slow_startup")) {
    recommendations.add("Medir tempo ate primeiro frame e validar preload, init segments e DNS/TLS.");
  }
  if (player === "hlsjs" || player === "shaka") {
    recommendations.add("Cruzar eventos do player com snapshot do manifesto e segmentos iniciais.");
  }
  if (player === "exoplayer" || player === "avplayer") {
    recommendations.add("Capturar telemetria de estado, mudancas de track e erros de renderer/DRM.");
  }
  if (recommendations.size === 0) {
    recommendations.add("Expandir coleta com eventos de rede, ABR e timestamps do primeiro frame.");
  }
  return [...recommendations];
}

function countNonEmptyLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim()).length;
}
