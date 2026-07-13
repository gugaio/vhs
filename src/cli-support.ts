import type { StreamerCloneProgressEvent } from "./stream/model.js";

export type RawCliOptions = Record<string, string | boolean | undefined>;

function toFlag(key: string): string {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/** Typed reader over commander's option record: removes repeated casts and flag strings. */
export class CliOptions {
  constructor(private readonly raw: RawCliOptions) {}

  string(key: string): string | undefined {
    const value = this.raw[key];
    return typeof value === "string" ? value : undefined;
  }

  bool(key: string): boolean {
    return this.raw[key] === true;
  }

  number(key: string): number | undefined {
    const value = this.string(key);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${toFlag(key)} must be a number`);
    return parsed;
  }

  requiredNumber(key: string): number {
    const value = this.number(key);
    if (value === undefined) throw new Error(`${toFlag(key)} is required`);
    return value;
  }
}

export function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (isReport(value)) {
    console.log(`ok=${value.ok}`);
    console.log(`summary=${value.summary}`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function isReport(value: unknown): value is { ok: boolean; summary: string } {
  return typeof value === "object" && value !== null
    && "ok" in value && typeof value.ok === "boolean"
    && "summary" in value && typeof value.summary === "string";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function logCloneProgress(event: StreamerCloneProgressEvent): void {
  const write = (message: string) => process.stderr.write(`[vhs] ${message}\n`);
  switch (event.type) {
    case "start":
      write(`preparando origin ${event.originId} | alvo=${event.durationSeconds}s | variants=${event.allVariants ? "todas" : "selecionada"}`);
      return;
    case "manifest_fetch":
      write("baixando manifesto raiz...");
      return;
    case "manifest_ready":
      write(`manifesto pronto | tipo=${event.playlistType} | variants=${event.variantCount} | segmentos=${event.segmentCount}`);
      return;
    case "variant_inspect":
      write(`inspecionando variant ${event.variantIndex + 1}/${event.variantCount}: ${event.label}`);
      return;
    case "variant_ready":
      write(`variant pronta ${event.variantIndex + 1}/${event.variantCount} | segmentos=${event.segmentCount} | target=${event.targetDuration}s`);
      return;
    case "segment_download_start":
      write(`baixando segmento ${event.segmentIndex + 1}/${event.segmentCount} da variant ${event.variantIndex + 1}/${event.variantCount}${event.originalSegmentIndex === undefined ? "" : ` | origem=${event.originalSegmentIndex}`}`);
      return;
    case "segment_download_retry":
      write(`retry segmento ${event.segmentIndex + 1}/${event.segmentCount} | tentativa ${event.attempt}/${event.maxAttempts} | ${event.error}`);
      return;
    case "segment_downloaded":
      write(`segmento salvo ${event.segmentIndex + 1}/${event.segmentCount} | ${formatBytes(event.bytes)} | total=${formatBytes(event.cumulativeBytes)}`);
      return;
    case "complete":
      write(`clone concluido ${event.originId} | variants=${event.variantCount} | segmentos=${event.segmentCount} | ${formatBytes(event.bytes)} | ${event.cumulativeDurationSeconds.toFixed(1)}s`);
      return;
  }
}

export function streamFormat(url: string, value: string | undefined): "hls" | "dash" {
  const format = value?.toLowerCase() ?? "auto";
  if (format === "hls" || format === "dash") return format;
  if (format !== "auto") throw new Error("--format must be auto, hls, or dash");
  return new URL(url).pathname.toLowerCase().endsWith(".mpd") ? "dash" : "hls";
}

export async function waitForStop(close: () => Promise<void>): Promise<void> {
  const stop = () => void close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>(() => undefined);
}
