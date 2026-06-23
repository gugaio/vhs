#!/usr/bin/env node
import { Command } from "commander";
import { createVhs } from "./vhs.js";
import type { StreamerCloneProgressEvent } from "./stream/model.js";

function print(value: unknown, json: boolean): void {
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

function optionalNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function logCloneProgress(event: StreamerCloneProgressEvent): void {
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

function streamFormat(url: string, value: string | undefined): "hls" | "dash" {
  const format = value?.toLowerCase() ?? "auto";
  if (format === "hls" || format === "dash") return format;
  if (format !== "auto") throw new Error("--format must be auto, hls, or dash");
  return new URL(url).pathname.toLowerCase().endsWith(".mpd") ? "dash" : "hls";
}

async function waitForStop(close: () => Promise<void>): Promise<void> {
  const stop = () => void close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const program = new Command().name("vhs").description("Video Harness System");
  program.option("--data-dir <path>", "directory for cloned stream origins");
  const getVhs = () => createVhs({ dataDir: program.opts<{ dataDir?: string }>().dataDir });

  program
    .command("audit <url>")
    .option("--max-segments <n>")
    .option("--timeout-ms <ms>")
    .option("--follow-variants")
    .option("--max-variants <n>")
    .option("--json", "write the complete machine-readable report")
    .action(async (url: string, options: Record<string, string | boolean | undefined>) => {
      const vhs = await getVhs();
      const report = await vhs.manifest.audit.audit({
        url,
        maxSegments: optionalNumber(options.maxSegments as string | undefined, "--max-segments"),
        timeoutMs: optionalNumber(options.timeoutMs as string | undefined, "--timeout-ms"),
        followVariants: options.followVariants === true,
        maxVariants: optionalNumber(options.maxVariants as string | undefined, "--max-variants"),
      });
      print(report, options.json === true);
      if (!report.ok) process.exitCode = 2;
    });

  program
    .command("inspect <url>")
    .option("--format <format>", "auto, hls, or dash", "auto")
    .option("--max-segments <n>")
    .option("--timeout-ms <ms>")
    .option("--json")
    .action(async (url: string, options: Record<string, string | boolean | undefined>) => {
      const vhs = await getVhs();
      const params = {
        url,
        maxSegments: optionalNumber(options.maxSegments as string | undefined, "--max-segments"),
        timeoutMs: optionalNumber(options.timeoutMs as string | undefined, "--timeout-ms"),
      };
      const result = streamFormat(url, options.format as string | undefined) === "dash"
        ? await vhs.inspect.inspectDash(params)
        : await vhs.inspect.inspectHls(params);
      print(result, options.json === true);
      if (!result.ok) process.exitCode = 2;
    });

  program
    .command("clone <url>")
    .option("--format <format>", "auto, hls, or dash", "auto")
    .option("--duration <seconds>", "target duration", "60")
    .option("--start <seconds>", "approximate start offset")
    .option("--start-segment <n>")
    .option("--segment-count <n>")
    .option("--variant <selector>", "variant selector", "aac-highest")
    .option("--all-variants")
    .option("--max-variants <n>")
    .option("--timeout-ms <ms>")
    .option("--segment-timeout-ms <ms>")
    .option("--segment-retries <n>")
    .option("--max-segments <n>")
    .option("--id <id>")
    .option("--json")
    .action(async (url: string, options: Record<string, string | boolean | undefined>) => {
      const vhs = await getVhs();
      const format = streamFormat(url, options.format as string | undefined);
      const clone = {
        url,
        format,
        durationSeconds: optionalNumber(options.duration as string | undefined, "--duration"),
        startSeconds: optionalNumber(options.start as string | undefined, "--start"),
        startSegment: optionalNumber(options.startSegment as string | undefined, "--start-segment"),
        segmentCount: optionalNumber(options.segmentCount as string | undefined, "--segment-count"),
        variant: options.variant as string | undefined,
        allVariants: options.allVariants === true,
        maxVariants: optionalNumber(options.maxVariants as string | undefined, "--max-variants"),
        timeoutMs: optionalNumber(options.timeoutMs as string | undefined, "--timeout-ms"),
        segmentTimeoutMs: optionalNumber(options.segmentTimeoutMs as string | undefined, "--segment-timeout-ms"),
        segmentRetries: optionalNumber(options.segmentRetries as string | undefined, "--segment-retries"),
        maxSegments: optionalNumber(options.maxSegments as string | undefined, "--max-segments"),
        originId: options.id as string | undefined,
        onProgress: logCloneProgress,
      };
      const result = format === "dash" ? await vhs.stream.cloneDash(clone) : await vhs.stream.cloneHls(clone);
      if (options.json) print(result, true);
      else console.log(`origin=${result.id}\nmanifest=${result.manifestPath}\nsegments=${result.segmentCount}`);
    });

  program.command("origins").option("--json").action(async (options: { json?: boolean }) => {
    const origins = await (await getVhs()).stream.listOrigins();
    if (options.json) return print(origins, true);
    console.log(origins.map((origin) => `${origin.id} ${origin.protocol ?? "hls"} ${origin.segmentCount} segments`).join("\n"));
  });

  program.command("origin <origin-id>").option("--json").action(async (originId: string, options: { json?: boolean }) => {
    print(await (await getVhs()).stream.inspectOrigin(originId), options.json === true);
  });

  program.command("probe <origin-id>").option("--timeout-ms <ms>").option("--json").action(async (originId: string, options: Record<string, string | boolean | undefined>) => {
    const report = await (await getVhs()).stream.probeOrigin(originId, { timeoutMs: optionalNumber(options.timeoutMs as string | undefined, "--timeout-ms") });
    print(report, options.json === true);
    if (!report.ok) process.exitCode = 2;
  });

  program.command("analyze <origin-id>").option("--full").option("--json").action(async (originId: string, options: { full?: boolean; json?: boolean }) => {
    const report = await (await getVhs()).stream.analyzeOrigin(originId, { full: options.full === true });
    print(report, options.json === true);
    if (!report.ok) process.exitCode = 2;
  });

  program
    .command("mutate <origin-id>")
    .requiredOption("--fault <type>", "discontinuity or segment-swap")
    .requiredOption("--at-segment <n>")
    .option("--target <kind>", "variant or rendition", "variant")
    .option("--target-index <n>", "target playlist index", "0")
    .option("--with-origin <origin-id>")
    .option("--with-segment <n>")
    .option("--with-discontinuity")
    .option("--id <id>")
    .option("--json")
    .action(async (originId: string, options: Record<string, string | boolean | undefined>) => {
      const fault = options.fault as string;
      if (fault !== "discontinuity" && fault !== "segment-swap") throw new Error("--fault must be discontinuity or segment-swap");
      const target = options.target as string;
      if (target !== "variant" && target !== "rendition") throw new Error("--target must be variant or rendition");
      const result = await (await getVhs()).stream.mutateOrigin({
        originId,
        fault,
        segmentIndex: optionalNumber(options.atSegment as string, "--at-segment") as number,
        targetKind: target,
        targetIndex: optionalNumber(options.targetIndex as string, "--target-index"),
        donorOriginId: options.withOrigin as string | undefined,
        donorSegmentIndex: optionalNumber(options.withSegment as string | undefined, "--with-segment"),
        withDiscontinuity: options.withDiscontinuity === true,
        newOriginId: options.id as string | undefined,
      });
      if (options.json) print(result, true);
      else console.log(`origin=${result.origin.id}\nfault=${result.fault.type}`);
    });

  program.command("remove <origin-id>").requiredOption("--yes", "confirm origin removal").option("--json").action(async (originId: string, options: { json?: boolean }) => {
    print(await (await getVhs()).stream.removeOrigin(originId), options.json === true);
  });

  program.command("serve <origin-id>").option("--host <host>", "bind host", "127.0.0.1").option("--port <n>", "bind port", "0").option("--json").action(async (originId: string, options: Record<string, string | boolean | undefined>) => {
    const handle = await (await getVhs()).stream.serveOrigin(originId, { host: options.host as string, port: optionalNumber(options.port as string | undefined, "--port") });
    print(handle, options.json === true);
    await waitForStop(handle.close);
  });

  program.command("live <origin-id>").option("--host <host>", "bind host", "127.0.0.1").option("--port <n>", "bind port", "0").option("--window-size <n>", "segments per live window", "5").option("--json").action(async (originId: string, options: Record<string, string | boolean | undefined>) => {
    const handle = await (await getVhs()).stream.serveLiveOrigin(originId, {
      host: options.host as string,
      port: optionalNumber(options.port as string | undefined, "--port"),
      windowSize: optionalNumber(options.windowSize as string | undefined, "--window-size"),
    });
    print(handle, options.json === true);
    await waitForStop(handle.close);
  });

  program
    .command("diff <left-url> <right-url>")
    .option("--max-segments <n>")
    .option("--timeout-ms <ms>")
    .option("--follow-variants")
    .option("--max-variants <n>")
    .option("--json", "write the complete machine-readable report")
    .action(async (leftUrl: string, rightUrl: string, options: Record<string, string | boolean | undefined>) => {
      const vhs = await getVhs();
      const report = await vhs.manifest.diff.diff({
        leftUrl,
        rightUrl,
        maxSegments: optionalNumber(options.maxSegments as string | undefined, "--max-segments"),
        timeoutMs: optionalNumber(options.timeoutMs as string | undefined, "--timeout-ms"),
        followVariants: options.followVariants === true,
        maxVariants: optionalNumber(options.maxVariants as string | undefined, "--max-variants"),
      });
      print(report, options.json === true);
      if (!report.ok) process.exitCode = 2;
    });

  await program.parseAsync();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: { code: "vhs_error", message } }));
  process.exitCode = 1;
});
