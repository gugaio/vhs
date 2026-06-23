import type { PlaybackEvent, PlaybackIssue } from "./playback.js";

export function parseHlsJsLogText(logText: string): PlaybackEvent[] {
  const lines = logText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => parseHlsJsLine(line, index));
}

export function deriveHlsJsIssues(events: PlaybackEvent[]): PlaybackIssue[] {
  const issues: PlaybackIssue[] = [];
  const fragLoadErrors = events.filter((event) =>
    event.name === "frag_load_error" || event.detail?.toLowerCase().includes("frag_load_error"),
  );
  const manifestLoadErrors = events.filter((event) =>
    event.name === "manifest_load_error" || event.detail?.toLowerCase().includes("manifest_load_error"),
  );
  const levelSwitches = events.filter((event) => event.name === "level_switched");

  if (manifestLoadErrors.length > 0) {
    issues.push({
      code: "manifest_load_error",
      severity: "error",
      summary: `Sessao teve ${manifestLoadErrors.length} erro(s) de carga de manifesto no hls.js.`,
      evidence: manifestLoadErrors.slice(0, 3).map((event) => `${event.atMs}ms:${event.detail ?? event.name}`),
    });
  }

  if (fragLoadErrors.length > 0) {
    issues.push({
      code: "frag_load_error",
      severity: fragLoadErrors.some((event) => event.fatal) ? "error" : "warning",
      summary: `Sessao teve ${fragLoadErrors.length} erro(s) de fragmento no hls.js.`,
      evidence: fragLoadErrors.slice(0, 4).map((event) => `${event.atMs}ms:${event.detail ?? event.name}`),
    });
  }

  if (levelSwitches.length >= 4) {
    issues.push({
      code: "level_switch_oscillation",
      severity: "warning",
      summary: `Sessao teve ${levelSwitches.length} mudancas de nivel/bitrate; pode haver oscilacao de ABR.`,
      evidence: levelSwitches.slice(0, 5).map((event) => `${event.atMs}ms:${event.detail ?? event.name}`),
    });
  }

  return issues;
}

function parseHlsJsLine(line: string, index: number): PlaybackEvent {
  const lower = line.toLowerCase();
  const atMs = inferTimestampMs(line, index);
  const name = inferHlsJsEventName(lower);
  return {
    atMs,
    name,
    category: inferHlsJsCategory(lower, name),
    fatal: /\bfatal\b/.test(lower) || /\bfatal:\s*true\b/.test(lower),
    detail: line,
  };
}

function inferTimestampMs(line: string, index: number): number {
  const match =
    line.match(/\b(\d+(?:\.\d+)?)\s*ms\b/i) ||
    line.match(/\bt=(\d+(?:\.\d+)?)\b/i) ||
    line.match(/\[(\d+(?:\.\d+)?)ms\]/i);
  if (!match) {
    return index * 1000;
  }
  const value = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(value) ? Math.round(value) : index * 1000;
}

function inferHlsJsEventName(lower: string): string {
  if (lower.includes("frag_load_error") || lower.includes("frag load error")) return "frag_load_error";
  if (lower.includes("manifest_load_error") || lower.includes("manifest load error")) return "manifest_load_error";
  if (lower.includes("buffer_stalled_error") || lower.includes("buffer stall")) return "buffer_stall";
  if (lower.includes("level_switched")) return "level_switched";
  if (lower.includes("manifest loaded")) return "manifest_loaded";
  if (lower.includes("frag loaded")) return "frag_loaded";
  if (lower.includes("playing")) return "playing";
  if (lower.includes("error")) return "error";
  if (lower.includes("audio track switched")) return "audio_track_switched";
  return "log_line";
}

function inferHlsJsCategory(lower: string, name: string): PlaybackEvent["category"] {
  if (lower.includes("fatal network error")) {
    return "error";
  }
  if (name === "manifest_load_error" || name === "frag_load_error" || lower.includes("networkerror")) {
    return "error";
  }
  if (name === "buffer_stall" || lower.includes("rebuffer") || lower.includes("buffer")) {
    return "buffer";
  }
  if (name === "level_switched" || lower.includes("bitrate")) {
    return "abr";
  }
  if (name === "manifest_loaded" || name === "playing" || name === "frag_loaded") {
    return "lifecycle";
  }
  if (lower.includes("drm") || lower.includes("license")) {
    return "drm";
  }
  if (lower.includes("manifest") || lower.includes("frag") || lower.includes("segment")) {
    return "network";
  }
  if (lower.includes("error") || lower.includes("fatal")) {
    return "error";
  }
  return "quality";
}
