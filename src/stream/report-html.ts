import type { StreamerOriginAnalysisReport, StreamerSegmentAnalysisEntry } from "./model.js";

export function renderStreamerAnalysisHtml(report: StreamerOriginAnalysisReport): string {
  const audioProblems = report.entries
    .filter((entry) => entry.type === "AUDIO" && typeof entry.nextDeltaUs === "number")
    .filter((entry) => entry.continuityStatus === "gap" || entry.continuityStatus === "overlap")
    .sort((left, right) => Math.abs(right.nextDeltaUs ?? 0) - Math.abs(left.nextDeltaUs ?? 0));
  const maxAudioDeltaUs = audioProblems[0]?.nextDeltaUs;
  const timelineDriftWindows = report.avAlignment.timelineDriftWindows ?? [];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VHS Stream Analysis - ${escapeHtml(report.originId)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --panel: #ffffff;
      --ink: #1d2527;
      --muted: #667174;
      --line: #d8ded9;
      --ok: #18794e;
      --warn: #a15c00;
      --error: #ba1a1a;
      --gap: #fff3d6;
      --overlap: #fde7e7;
      --reset: #e7eefc;
      --unknown: #ecefed;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #eef2ea 0, var(--bg) 280px);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 28px 32px 18px;
      border-bottom: 1px solid var(--line);
    }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 26px; }
    h2 { font-size: 17px; margin: 28px 0 10px; }
    .subtle { color: var(--muted); }
    main { padding: 0 32px 36px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin-top: 18px;
    }
    .metric {
      background: rgba(255,255,255,.72);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }
    .metric strong { display: block; font-size: 20px; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      background: #eef2ea;
      color: #384244;
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    .scroll { overflow-x: auto; }
    .status-ok { color: var(--ok); font-weight: 700; }
    .status-warn, .status-gap, .status-overlap { color: var(--warn); font-weight: 700; }
    .status-error { color: var(--error); font-weight: 700; }
    .row-gap { background: var(--gap); }
    .row-overlap { background: var(--overlap); }
    .row-reset { background: var(--reset); }
    .row-unknown { background: var(--unknown); }
    code {
      font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #263235;
    }
    .evidence { color: var(--muted); white-space: normal; }
    .asset-time strong { display: block; }
    .asset-time .raw { display: block; color: var(--muted); font-size: 12px; }
    @media (max-width: 760px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      th, td { padding: 7px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>VHS Stream Analysis</h1>
    <div class="subtle">origin=${escapeHtml(report.originId)} · generated=${escapeHtml(new Date().toISOString())}</div>
    <div class="grid">
      ${metric("Sampled segments", `${report.okSegments}/${report.sampledSegments}`)}
      ${metric("Playlists", `${report.sampledMediaPlaylists}/${report.totalMediaPlaylists}`)}
      ${metric("Issues", String(report.issues.length))}
      ${metric("A/V alignment", report.avAlignment.status)}
      ${metric("Worst audio timestamp delta", typeof maxAudioDeltaUs === "number" ? formatUs(maxAudioDeltaUs) : "n/a")}
      ${metric("Worst A/V timeline drift", typeof report.avAlignment.maxTimelineDriftSeconds === "number" ? formatSeconds(report.avAlignment.maxTimelineDriftSeconds) : "n/a")}
    </div>
  </header>
  <main>
    <h2>Top Problems</h2>
    ${renderIssues(report)}
    <h2>Audio Timestamp Discontinuities</h2>
    ${renderAudioProblems(audioProblems)}
    <h2>A/V Timeline Drift</h2>
    ${renderTimelineDrift(timelineDriftWindows)}
    <h2>Media Summary</h2>
    ${renderMediaSummary(report)}
    <h2>Chunk Detail</h2>
    ${renderChunkTable(report.entries)}
    <script id="vhs-analysis-json" type="application/json">${escapeScriptJson(JSON.stringify(report))}</script>
  </main>
</body>
</html>
`;
}

function renderIssues(report: StreamerOriginAnalysisReport): string {
  if (report.issues.length === 0) {
    return `<p class="subtle">No structured issues were detected.</p>`;
  }
  return `<div class="scroll"><table>
    <thead><tr><th>Severity</th><th>Code</th><th>Summary</th><th>Evidence</th></tr></thead>
    <tbody>${report.issues.map((issue) => `<tr>
      <td class="status-${escapeHtml(issue.severity)}">${escapeHtml(issue.severity)}</td>
      <td><code>${escapeHtml(issue.code)}</code></td>
      <td>${escapeHtml(issue.summary)}</td>
      <td class="evidence">${escapeHtml(issue.evidence.join(" | "))}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderAudioProblems(entries: StreamerSegmentAnalysisEntry[]): string {
  if (entries.length === 0) {
    return `<p class="subtle">No audio timestamp gaps or overlaps were detected.</p>`;
  }
  return `<div class="scroll"><table>
    <thead><tr><th>Media</th><th>Segment</th><th>Status</th><th>Expected</th><th>Actual</th><th>Delta</th><th>File</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr class="row-${escapeHtml(entry.continuityStatus ?? "unknown")}">
      <td>${escapeHtml(`${entry.kind}[${entry.mediaIndex}]`)}</td>
      <td>${entry.segmentIndex - 1} -> ${entry.segmentIndex}</td>
      <td class="status-${escapeHtml(entry.continuityStatus ?? "unknown")}">${escapeHtml(entry.continuityStatus ?? "unknown")}</td>
      <td>${formatPtsUs(entry.nextExpectedPtsUs)}</td>
      <td>${formatPtsUs(entry.nextActualPtsUs)}</td>
      <td>${typeof entry.nextDeltaUs === "number" ? formatUs(entry.nextDeltaUs) : "n/a"}</td>
      <td><code>${escapeHtml(entry.localPath)}</code></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderTimelineDrift(windows: NonNullable<StreamerOriginAnalysisReport["avAlignment"]["timelineDriftWindows"]>): string {
  if (windows.length === 0) {
    return `<p class="subtle">No audio/video manifest timeline drift windows were detected.</p>`;
  }
  return `<div class="scroll"><table>
    <thead><tr><th>Status</th><th>Video Seg</th><th>Audio</th><th>Asset Time</th><th>Video Dur</th><th>Audio Dur</th><th>Start Delta</th><th>End Delta</th><th>Duration Delta</th><th>Actual Delta</th></tr></thead>
    <tbody>${windows.map((window) => `<tr class="row-${escapeHtml(window.status)}">
      <td class="status-${escapeHtml(window.status)}">${escapeHtml(window.status)}</td>
      <td>${window.videoSegmentIndex}</td>
      <td>rendition[${window.audioMediaIndex}] seg[${window.audioSegmentIndex}]</td>
      <td>${formatTimelineRange(window.timelineStartSeconds, window.timelineEndSeconds)}</td>
      <td>${formatSeconds(window.videoDurationSeconds)}</td>
      <td>${formatSeconds(window.audioDurationSeconds)}</td>
      <td>${formatSignedSeconds(window.startDeltaSeconds)}</td>
      <td>${formatSignedSeconds(window.endDeltaSeconds)}</td>
      <td>${formatSignedSeconds(window.durationDeltaSeconds)}</td>
      <td>${formatSignedSeconds(window.actualDurationDeltaSeconds)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderMediaSummary(report: StreamerOriginAnalysisReport): string {
  return `<div class="scroll"><table>
    <thead><tr><th>Media</th><th>Type</th><th>Segments</th><th>Boundary</th><th>Duration Delta Max</th><th>GOP</th><th>Label</th></tr></thead>
    <tbody>${report.media.map((media) => `<tr>
      <td>${escapeHtml(`${media.kind}[${media.mediaIndex}]`)}</td>
      <td>${escapeHtml(media.type)}</td>
      <td>${media.sampledSegments}</td>
      <td class="status-${escapeHtml(media.boundaryStatus === "warn" ? "warn" : media.boundaryStatus)}">${escapeHtml(media.boundaryStatus)}</td>
      <td>${formatSeconds(media.durationDeltaMaxSeconds)}</td>
      <td>${escapeHtml(media.gopStatus ?? "n/a")}</td>
      <td>${escapeHtml(media.label)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderChunkTable(entries: StreamerSegmentAnalysisEntry[]): string {
  return `<div class="scroll"><table>
    <thead><tr><th>Media</th><th>Type</th><th>Seg</th><th>Asset Time</th><th>Status</th><th>EXTINF</th><th>Actual</th><th>First PTS</th><th>Last PTS</th><th>Expected</th><th>Actual Next</th><th>Delta</th><th>Codec</th><th>Packets</th><th>Path</th></tr></thead>
    <tbody>${entries.map((entry) => `<tr class="row-${escapeHtml(entry.continuityStatus ?? entry.boundaryStatus ?? "unknown")}">
      <td>${escapeHtml(`${entry.kind}[${entry.mediaIndex}]`)}</td>
      <td>${escapeHtml(entry.type)}</td>
      <td>${entry.segmentIndex}</td>
      <td>${formatAssetTime(entry)}</td>
      <td class="status-${escapeHtml(entry.continuityStatus ?? entry.boundaryStatus ?? "unknown")}">${escapeHtml(entry.continuityStatus ?? entry.boundaryStatus ?? "unknown")}</td>
      <td>${formatSeconds(entry.declaredDurationSeconds)}</td>
      <td>${formatSeconds(entry.actualDurationSeconds)}</td>
      <td>${formatPtsUs(entry.firstPtsUs)}</td>
      <td>${formatPtsUs(entry.lastPtsUs)}</td>
      <td>${formatPtsUs(entry.nextExpectedPtsUs)}</td>
      <td>${formatPtsUs(entry.nextActualPtsUs)}</td>
      <td>${typeof entry.nextDeltaUs === "number" ? formatUs(entry.nextDeltaUs) : "n/a"}</td>
      <td>${escapeHtml(formatCodec(entry))}</td>
      <td>${entry.packetCount ?? "n/a"}</td>
      <td><code>${escapeHtml(entry.localPath)}</code></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span class="subtle">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatAssetTime(entry: StreamerSegmentAnalysisEntry): string {
  if (typeof entry.timelineStartSeconds !== "number" || typeof entry.timelineEndSeconds !== "number") {
    return "n/a";
  }
  return formatTimelineRange(entry.timelineStartSeconds, entry.timelineEndSeconds);
}

function formatCodec(entry: StreamerSegmentAnalysisEntry): string {
  return [
    entry.codecName,
    typeof entry.sampleRate === "number" ? `${entry.sampleRate}Hz` : undefined,
    typeof entry.channels === "number" ? `${entry.channels}ch` : undefined,
  ].filter((value): value is string => Boolean(value)).join(" ") || "n/a";
}

function formatSeconds(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(3)}s` : "n/a";
}

function formatSignedSeconds(value: number | undefined): string {
  if (typeof value !== "number") {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatSeconds(value)}`;
}

function formatTimelineRange(startSeconds: number, endSeconds: number): string {
  const raw = `${formatSeconds(startSeconds)} -> ${formatSeconds(endSeconds)}`;
  const human = `${formatClockTime(startSeconds)} -> ${formatClockTime(endSeconds)}`;
  return `<span class="asset-time" title="${escapeHtml(raw)}"><strong>${human}</strong><span class="raw">${raw}</span></span>`;
}

function formatClockTime(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${padTime(minutes)}:${padTime(seconds)}`;
  }
  return `${minutes}:${padTime(seconds)}`;
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUs(value: number): string {
  return `${(value / 1_000).toFixed(3)}ms`;
}

function formatUsRaw(value: number | undefined): string {
  return typeof value === "number" ? `${value}us` : "n/a";
}

function formatPtsUs(value: number | undefined): string {
  if (typeof value !== "number") {
    return "n/a";
  }
  const seconds = value / 1_000_000;
  const human = seconds >= 3600 ? formatClockTimeWithMillis(seconds) : `${seconds.toFixed(3)}s`;
  return `<span class="asset-time" title="${escapeHtml(formatUsRaw(value))}"><strong>${human}</strong><span class="raw">${formatUsRaw(value)}</span></span>`;
}

function formatClockTimeWithMillis(value: number): string {
  const totalMilliseconds = Math.max(0, Math.floor(value * 1_000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${hours}:${padTime(minutes)}:${padTime(seconds)}.${String(milliseconds).padStart(3, "0")}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeScriptJson(value: string): string {
  return value.replaceAll("</", "<\\/");
}
