import { describe, expect, it } from "vitest";
import { PlaybackTriageService } from "../src/playback.js";

describe("PlaybackTriageService", () => {
  it("classifica sessao com stall e erro fatal", () => {
    const service = new PlaybackTriageService();
    const report = service.analyzeSession({
      player: "hlsjs",
      streamUrl: "https://example.com/master.m3u8",
      events: [
        { atMs: 0, name: "manifest_loaded", category: "lifecycle" },
        { atMs: 4200, name: "playing", category: "lifecycle" },
        { atMs: 9000, name: "buffer_stall", category: "buffer", detail: "buffer empty" },
        { atMs: 12000, name: "rebuffer_start", category: "buffer" },
        { atMs: 15000, name: "fatal_network_error", category: "error", fatal: true, detail: "frag load error" },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.metrics.rebufferCount).toBe(2);
    expect(report.metrics.fatalErrorCount).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toContain("fatal_error");
    expect(report.issues.map((issue) => issue.code)).toContain("rebuffering");
    expect(report.issues.map((issue) => issue.code)).toContain("slow_startup");
  });

  it("marca sessao limpa quando nao encontra sinais fortes de problema", () => {
    const service = new PlaybackTriageService();
    const report = service.analyzeSession({
      player: "exoplayer",
      events: [
        { atMs: 0, name: "source_set", category: "lifecycle" },
        { atMs: 900, name: "ready", category: "lifecycle" },
        { atMs: 2400, name: "track_changed", category: "abr" },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.code).toBe("clean_session");
  });

  it("aceita log bruto como entrada principal", () => {
    const service = new PlaybackTriageService();
    const report = service.analyzeSession({
      player: "hlsjs",
      logText: `
        [4200ms] playback playing
        [9000ms] buffer stall detected
        [12000ms] rebuffer start
        [15000ms] fatal network error: frag load error
      `,
    });

    expect(report.ok).toBe(false);
    expect(report.metrics.eventCount).toBe(4);
    expect(report.metrics.rebufferCount).toBe(2);
    expect(report.metrics.fatalErrorCount).toBe(1);
    expect(report.issues.map((issue) => issue.code)).toContain("fatal_error");
    expect(report.issues.map((issue) => issue.code)).toContain("rebuffering");
  });

  it("enriquece analise de hls.js com issues especificas do player", () => {
    const service = new PlaybackTriageService();
    const report = service.analyzeSession({
      player: "hlsjs",
      logText: `
        [100ms] MANIFEST_LOAD_ERROR fatal: true
        [1000ms] LEVEL_SWITCHED level=0 bitrate=800000
        [2000ms] LEVEL_SWITCHED level=1 bitrate=1500000
        [3000ms] LEVEL_SWITCHED level=0 bitrate=800000
        [4000ms] LEVEL_SWITCHED level=1 bitrate=1500000
        [5000ms] FRAG_LOAD_ERROR fatal: false frag sn=44
      `,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("manifest_load_error");
    expect(report.issues.map((issue) => issue.code)).toContain("frag_load_error");
    expect(report.issues.map((issue) => issue.code)).toContain("level_switch_oscillation");
  });
});
