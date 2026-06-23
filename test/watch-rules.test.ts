import { describe, expect, it } from "vitest";
import { analyzeSnapshotTransition, toHlsSnapshot } from "../src/watch-rules.js";
import type { HlsSnapshot } from "../src/watch.js";

function makeSnapshot(overrides: Partial<HlsSnapshot> = {}): HlsSnapshot {
  return {
    fetchedAt: Date.now(),
    mediaSequence: 100,
    discontinuitySequence: 0,
    targetDuration: 6,
    segments: [
      { uri: "seg100.ts", duration: 6 },
      { uri: "seg101.ts", duration: 6 },
      { uri: "seg102.ts", duration: 6 },
    ],
    discontinuityMarkers: [],
    hasAudioRenditions: false,
    audioRenditionCount: 0,
    ...overrides,
  };
}

describe("analyzeSnapshotTransition – sem problemas", () => {
  it("não emite eventos quando manifest avança normalmente", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000, mediaSequence: 100 });
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 101 });
    expect(analyzeSnapshotTransition(prev, next)).toHaveLength(0);
  });
});

describe("analyzeSnapshotTransition – discontinuity_inserted", () => {
  it("detecta salto em EXT-X-DISCONTINUITY-SEQUENCE", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000, discontinuitySequence: 2 });
    const next = makeSnapshot({ fetchedAt: now, discontinuitySequence: 3 });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("discontinuity_inserted");
    expect(events[0]?.severity).toBe("warning");
    expect(events[0]?.evidence.some((e) => e.includes("jump=1"))).toBe(true);
  });

  it("detecta marcador de discontinuidade em segmentos novos", () => {
    const now = Date.now();
    // prev termina no mediaSequence 102 (seq 100 + 3 segmentos)
    const prev = makeSnapshot({
      fetchedAt: now - 6_000,
      mediaSequence: 100,
      segments: [
        { uri: "seg100.ts", duration: 6 },
        { uri: "seg101.ts", duration: 6 },
        { uri: "seg102.ts", duration: 6 },
      ],
    });
    // next começa em 101, tem segmento novo (seg103) com descontinuidade no índice 2
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      segments: [
        { uri: "seg101.ts", duration: 6 },
        { uri: "seg102.ts", duration: 6 },
        { uri: "seg103.ts", duration: 6 }, // índice 2 = novo segmento
      ],
      discontinuityMarkers: [2],
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "discontinuity_inserted")).toBe(true);
  });

  it("não emite evento se discontinuidade está em segmento já visto", () => {
    const now = Date.now();
    const prev = makeSnapshot({
      fetchedAt: now - 6_000,
      mediaSequence: 100,
      segments: [
        { uri: "seg100.ts", duration: 6 },
        { uri: "seg101.ts", duration: 6 },
        { uri: "seg102.ts", duration: 6 },
      ],
    });
    // next: mesmos segmentos com um marcador no índice 1 (segmento já existia no prev)
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 100,
      segments: [
        { uri: "seg100.ts", duration: 6 },
        { uri: "seg101.ts", duration: 6 },
        { uri: "seg102.ts", duration: 6 },
      ],
      discontinuityMarkers: [1],
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "discontinuity_inserted")).toBe(false);
  });
});

describe("analyzeSnapshotTransition – media_sequence_gap", () => {
  it("detecta gap quando mediaSequence avança mais que o esperado", () => {
    const now = Date.now();
    // Em 6 segundos esperamos avançar ~1 segmento de 6s; avançar 20 é suspeito
    const prev = makeSnapshot({ fetchedAt: now - 6_000, mediaSequence: 100, targetDuration: 6 });
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 120, targetDuration: 6 });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "media_sequence_gap")).toBe(true);
  });

  it("não emite gap para avanço normal", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 30_000, mediaSequence: 100, targetDuration: 6 });
    // 30s / 6s = 5 segmentos esperados, avançar 5 é normal
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 105, targetDuration: 6 });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "media_sequence_gap")).toBe(false);
  });

  it("evento tem severidade error para gaps muito grandes", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000, mediaSequence: 100, targetDuration: 6 });
    // 200 segmentos pulados em 6s — claramente um gap grande
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 300, targetDuration: 6 });
    const events = analyzeSnapshotTransition(prev, next);
    const gapEvent = events.find((e) => e.code === "media_sequence_gap");
    expect(gapEvent?.severity).toBe("error");
  });
});

describe("analyzeSnapshotTransition – stale_manifest", () => {
  it("detecta manifest congelado após 2x targetDuration", () => {
    const now = Date.now();
    // targetDuration=6s, congelado por 13s (> 12s threshold)
    const prev = makeSnapshot({ fetchedAt: now - 13_000, mediaSequence: 100, targetDuration: 6 });
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 100, targetDuration: 6 });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "stale_manifest")).toBe(true);
    expect(events.find((e) => e.code === "stale_manifest")?.severity).toBe("error");
  });

  it("não emite stale quando manifest acabou de ser atualizado", () => {
    const now = Date.now();
    // Mesmo mediaSequence mas intervalo de apenas 3s (< 12s threshold)
    const prev = makeSnapshot({ fetchedAt: now - 3_000, mediaSequence: 100, targetDuration: 6 });
    const next = makeSnapshot({ fetchedAt: now, mediaSequence: 100, targetDuration: 6 });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "stale_manifest")).toBe(false);
  });
});

describe("analyzeSnapshotTransition – segment_duration_anomaly", () => {
  it("detecta segmento muito curto (< 30% targetDuration)", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000 });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      targetDuration: 6,
      segments: [
        { uri: "seg101.ts", duration: 1.2 }, // < 30% de 6s = 1.8s
        { uri: "seg102.ts", duration: 6 },
        { uri: "seg103.ts", duration: 6 },
      ],
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "segment_duration_anomaly")).toBe(true);
  });

  it("detecta segmento muito longo (> 150% targetDuration)", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000 });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      targetDuration: 6,
      segments: [
        { uri: "seg101.ts", duration: 11 }, // > 150% de 6s = 9s
        { uri: "seg102.ts", duration: 6 },
      ],
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "segment_duration_anomaly")).toBe(true);
  });

  it("não emite anomalia para durações dentro do range aceitável", () => {
    const now = Date.now();
    const prev = makeSnapshot({ fetchedAt: now - 6_000 });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      targetDuration: 6,
      segments: [
        { uri: "seg101.ts", duration: 5.8 },
        { uri: "seg102.ts", duration: 6 },
        { uri: "seg103.ts", duration: 6.1 },
      ],
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "segment_duration_anomaly")).toBe(false);
  });
});

describe("analyzeSnapshotTransition – audio_rendition_gap", () => {
  it("detecta desaparecimento de rendições de áudio", () => {
    const now = Date.now();
    const prev = makeSnapshot({
      fetchedAt: now - 6_000,
      hasAudioRenditions: true,
      audioRenditionCount: 2,
    });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      hasAudioRenditions: false,
      audioRenditionCount: 0,
    });
    const events = analyzeSnapshotTransition(prev, next);
    const evt = events.find((e) => e.code === "audio_rendition_gap");
    expect(evt).toBeDefined();
    expect(evt?.severity).toBe("error");
  });

  it("detecta redução parcial de rendições de áudio", () => {
    const now = Date.now();
    const prev = makeSnapshot({
      fetchedAt: now - 6_000,
      hasAudioRenditions: true,
      audioRenditionCount: 3,
    });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      hasAudioRenditions: true,
      audioRenditionCount: 1,
    });
    const events = analyzeSnapshotTransition(prev, next);
    const evt = events.find((e) => e.code === "audio_rendition_gap");
    expect(evt).toBeDefined();
    expect(evt?.severity).toBe("warning");
  });

  it("não emite evento quando não havia rendições de áudio", () => {
    const now = Date.now();
    const prev = makeSnapshot({
      fetchedAt: now - 6_000,
      hasAudioRenditions: false,
      audioRenditionCount: 0,
    });
    const next = makeSnapshot({
      fetchedAt: now,
      mediaSequence: 101,
      hasAudioRenditions: false,
      audioRenditionCount: 0,
    });
    const events = analyzeSnapshotTransition(prev, next);
    expect(events.some((e) => e.code === "audio_rendition_gap")).toBe(false);
  });
});

describe("toHlsSnapshot", () => {
  it("converte resultado de inspect para snapshot corretamente", () => {
    const now = Date.now();
    const snapshot = toHlsSnapshot(
      {
        mediaSequence: 50,
        discontinuitySequence: 3,
        discontinuityMarkers: [1, 2],
        targetDuration: 8,
        segments: [
          { uri: "a.ts", duration: 8 },
          { uri: "b.ts", duration: 8 },
          { uri: "c.ts", duration: 8 },
        ],
        renditions: [
          { type: "AUDIO" },
          { type: "AUDIO" },
          { type: "SUBTITLES" },
        ],
      },
      now,
    );

    expect(snapshot.fetchedAt).toBe(now);
    expect(snapshot.mediaSequence).toBe(50);
    expect(snapshot.discontinuitySequence).toBe(3);
    expect(snapshot.targetDuration).toBe(8);
    expect(snapshot.segments).toHaveLength(3);
    expect(snapshot.discontinuityMarkers).toEqual([1, 2]);
    expect(snapshot.hasAudioRenditions).toBe(true);
    expect(snapshot.audioRenditionCount).toBe(2);
  });

  it("usa defaults seguros quando campos estão ausentes", () => {
    const snapshot = toHlsSnapshot(
      {
        discontinuityMarkers: [],
        segments: [],
        renditions: [],
      },
      Date.now(),
    );

    expect(snapshot.mediaSequence).toBe(0);
    expect(snapshot.discontinuitySequence).toBe(0);
    expect(snapshot.targetDuration).toBe(0);
    expect(snapshot.hasAudioRenditions).toBe(false);
  });
});
