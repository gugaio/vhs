import { describe, expect, it } from "vitest";
import { deriveHlsJsIssues, parseHlsJsLogText } from "../src/hlsjs.js";

describe("hls.js playback adapter", () => {
  it("parseia eventos conhecidos de hls.js a partir de log text", () => {
    const events = parseHlsJsLogText(`
      [100ms] MANIFEST loaded
      [900ms] LEVEL_SWITCHED level=2 bitrate=2500000
      [1200ms] BUFFER_STALLED_ERROR fatal: false
      [1800ms] FRAG_LOAD_ERROR fatal: true frag sn=33
    `);

    expect(events.map((event) => event.name)).toEqual([
      "manifest_loaded",
      "level_switched",
      "buffer_stall",
      "frag_load_error",
    ]);
    expect(events[3]?.fatal).toBe(true);
  });

  it("deriva issues especificas de manifest/frag/oscillation", () => {
    const events = parseHlsJsLogText(`
      [100ms] MANIFEST_LOAD_ERROR fatal: true
      [1000ms] LEVEL_SWITCHED level=0
      [2000ms] LEVEL_SWITCHED level=1
      [3000ms] LEVEL_SWITCHED level=0
      [4000ms] LEVEL_SWITCHED level=1
      [5000ms] FRAG_LOAD_ERROR fatal: false frag sn=44
    `);

    const issues = deriveHlsJsIssues(events);
    expect(issues.map((issue) => issue.code)).toContain("manifest_load_error");
    expect(issues.map((issue) => issue.code)).toContain("frag_load_error");
    expect(issues.map((issue) => issue.code)).toContain("level_switch_oscillation");
  });
});
