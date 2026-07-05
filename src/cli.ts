#!/usr/bin/env node
import { Command } from "commander";
import { createVhs } from "./vhs.js";
import { CliOptions, logCloneProgress, print, streamFormat, waitForStop } from "./cli-support.js";
import type { RawCliOptions } from "./cli-support.js";

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
    .action(async (url: string, raw: RawCliOptions) => {
      const options = new CliOptions(raw);
      const vhs = await getVhs();
      const report = await vhs.manifest.audit.audit({
        url,
        maxSegments: options.number("maxSegments"),
        timeoutMs: options.number("timeoutMs"),
        followVariants: options.bool("followVariants"),
        maxVariants: options.number("maxVariants"),
      });
      print(report, options.bool("json"));
      if (!report.ok) process.exitCode = 2;
    });

  program
    .command("inspect <url>")
    .option("--format <format>", "auto, hls, or dash", "auto")
    .option("--max-segments <n>")
    .option("--timeout-ms <ms>")
    .option("--json")
    .action(async (url: string, raw: RawCliOptions) => {
      const options = new CliOptions(raw);
      const vhs = await getVhs();
      const params = {
        url,
        maxSegments: options.number("maxSegments"),
        timeoutMs: options.number("timeoutMs"),
      };
      const result = streamFormat(url, options.string("format")) === "dash"
        ? await vhs.inspect.inspectDash(params)
        : await vhs.inspect.inspectHls(params);
      print(result, options.bool("json"));
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
    .action(async (url: string, raw: RawCliOptions) => {
      const options = new CliOptions(raw);
      const vhs = await getVhs();
      const format = streamFormat(url, options.string("format"));
      const clone = {
        url,
        format,
        durationSeconds: options.number("duration"),
        startSeconds: options.number("start"),
        startSegment: options.number("startSegment"),
        segmentCount: options.number("segmentCount"),
        variant: options.string("variant"),
        allVariants: options.bool("allVariants"),
        maxVariants: options.number("maxVariants"),
        timeoutMs: options.number("timeoutMs"),
        segmentTimeoutMs: options.number("segmentTimeoutMs"),
        segmentRetries: options.number("segmentRetries"),
        maxSegments: options.number("maxSegments"),
        originId: options.string("id"),
        onProgress: logCloneProgress,
      };
      const result = format === "dash" ? await vhs.stream.cloneDash(clone) : await vhs.stream.cloneHls(clone);
      if (options.bool("json")) print(result, true);
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

  program.command("probe <origin-id>").option("--timeout-ms <ms>").option("--json").action(async (originId: string, raw: RawCliOptions) => {
    const options = new CliOptions(raw);
    const report = await (await getVhs()).stream.probeOrigin(originId, { timeoutMs: options.number("timeoutMs") });
    print(report, options.bool("json"));
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
    .action(async (originId: string, raw: RawCliOptions) => {
      const options = new CliOptions(raw);
      const fault = options.string("fault");
      if (fault !== "discontinuity" && fault !== "segment-swap") throw new Error("--fault must be discontinuity or segment-swap");
      const target = options.string("target");
      if (target !== "variant" && target !== "rendition") throw new Error("--target must be variant or rendition");
      const result = await (await getVhs()).stream.mutateOrigin({
        originId,
        fault,
        segmentIndex: options.requiredNumber("atSegment"),
        targetKind: target,
        targetIndex: options.number("targetIndex"),
        donorOriginId: options.string("withOrigin"),
        donorSegmentIndex: options.number("withSegment"),
        withDiscontinuity: options.bool("withDiscontinuity"),
        newOriginId: options.string("id"),
      });
      if (options.bool("json")) print(result, true);
      else console.log(`origin=${result.origin.id}\nfault=${result.fault.type}`);
    });

  program.command("remove <origin-id>").requiredOption("--yes", "confirm origin removal").option("--json").action(async (originId: string, options: { json?: boolean }) => {
    print(await (await getVhs()).stream.removeOrigin(originId), options.json === true);
  });

  program.command("serve <origin-id>").option("--host <host>", "bind host", "127.0.0.1").option("--port <n>", "bind port", "0").option("--json").action(async (originId: string, raw: RawCliOptions) => {
    const options = new CliOptions(raw);
    const handle = await (await getVhs()).stream.serveOrigin(originId, { host: options.string("host") as string, port: options.number("port") });
    print(handle, options.bool("json"));
    await waitForStop(handle.close);
  });

  program.command("live <origin-id>").option("--host <host>", "bind host", "127.0.0.1").option("--port <n>", "bind port", "0").option("--window-size <n>", "segments per live window", "5").option("--json").action(async (originId: string, raw: RawCliOptions) => {
    const options = new CliOptions(raw);
    const handle = await (await getVhs()).stream.serveLiveOrigin(originId, {
      host: options.string("host") as string,
      port: options.number("port"),
      windowSize: options.number("windowSize"),
    });
    print(handle, options.bool("json"));
    await waitForStop(handle.close);
  });

  program
    .command("diff <left-url> <right-url>")
    .option("--max-segments <n>")
    .option("--timeout-ms <ms>")
    .option("--follow-variants")
    .option("--max-variants <n>")
    .option("--json", "write the complete machine-readable report")
    .action(async (leftUrl: string, rightUrl: string, raw: RawCliOptions) => {
      const options = new CliOptions(raw);
      const vhs = await getVhs();
      const report = await vhs.manifest.diff.diff({
        leftUrl,
        rightUrl,
        maxSegments: options.number("maxSegments"),
        timeoutMs: options.number("timeoutMs"),
        followVariants: options.bool("followVariants"),
        maxVariants: options.number("maxVariants"),
      });
      print(report, options.bool("json"));
      if (!report.ok) process.exitCode = 2;
    });

  await program.parseAsync();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: { code: "vhs_error", message } }));
  process.exitCode = 1;
});
