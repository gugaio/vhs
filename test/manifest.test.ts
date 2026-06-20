import { describe, expect, it } from "vitest";
import { ManifestAudit } from "../src/manifest.js";
import type { HlsInspectResult } from "../src/inspect.js";

function createInspectResult(overrides: Partial<HlsInspectResult> = {}): HlsInspectResult {
  return {
    ok: true,
    url: "https://example.com/master.m3u8",
    finalUrl: "https://example.com/master.m3u8",
    playlistType: "master",
    variants: [
      {
        uri: "720p.m3u8",
        url: "https://example.com/720p.m3u8",
        bandwidth: 2_000_000,
        codecs: "avc1.4d401f,mp4a.40.2",
        resolution: "1280x720",
      },
      {
        uri: "360p.m3u8",
        url: "https://example.com/360p.m3u8",
        bandwidth: 800_000,
        codecs: "avc1.4d401e,mp4a.40.2",
        resolution: "640x360",
      },
    ],
    renditions: [],
    segments: [],
    errors: [],
    discontinuityMarkers: [],
    ...overrides,
  };
}

describe("ManifestAudit", () => {
  it("marca master playlist limpa quando nao encontra sinais fortes de erro", async () => {
    const service = new ManifestAudit({
      inspectHls: async () => createInspectResult(),
    });

    const result = await service.audit({
      url: "https://example.com/master.m3u8",
    });

    expect(result.ok).toBe(true);
    expect(result.playlistType).toBe("master");
    expect(result.issues).toHaveLength(0);
    expect(result.variantAudits).toHaveLength(0);
    expect(result.aggregateIssues).toHaveLength(0);
    expect(result.stats.variantsAudited).toBe(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("detecta falhas estruturais em master playlist", async () => {
    const service = new ManifestAudit({
      inspectHls: async () =>
        createInspectResult({
          variants: [
            {
              uri: "broken.m3u8",
              url: "https://example.com/broken.m3u8",
              audioGroupId: "audio-main",
            },
          ],
        }),
    });

    const result = await service.audit({
      url: "https://example.com/master.m3u8",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("single_variant_ladder");
    expect(result.issues.map((issue) => issue.code)).toContain("variant_missing_bandwidth");
    expect(result.issues.map((issue) => issue.code)).toContain("variant_missing_codecs");
    expect(result.issues.map((issue) => issue.code)).toContain("missing_audio_group_rendition");
  });

  it("detecta problemas de segmentacao em media playlist", async () => {
    const service = new ManifestAudit({
      inspectHls: async () =>
        createInspectResult({
          playlistType: "media",
          variants: [],
          segments: [
            { uri: "seg-1.ts", url: "https://example.com/seg-1.ts", duration: 6 },
            { uri: "seg-2.ts", url: "https://example.com/seg-2.ts", duration: 10.2 },
            { uri: "seg-3.ts", url: "https://example.com/seg-3.ts", duration: 5.8 },
          ],
          targetDuration: 6,
        }),
    });

    const result = await service.audit({
      url: "https://example.com/media.m3u8",
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("segment_exceeds_target_duration");
    expect(result.issues.map((issue) => issue.code)).toContain("segment_duration_variation");
    expect(result.stats.maxSegmentDuration).toBeCloseTo(10.2);
  });

  it("expande a auditoria em memoria para variants e gera aggregate issues", async () => {
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const service = new ManifestAudit({
      inspectHls: async ({ url }) => {
        if (url === "https://example.com/master.m3u8") {
          return createInspectResult({
            variants: [
              {
                uri: "720p.m3u8",
                url: "https://example.com/720p.m3u8",
                bandwidth: 2_000_000,
                codecs: "avc1.4d401f,mp4a.40.2",
                resolution: "1280x720",
              },
              {
                uri: "720p-alt.m3u8",
                url: "https://example.com/720p-alt.m3u8",
                bandwidth: 2_100_000,
                codecs: "hvc1.1.6.L93,mp4a.40.2",
                resolution: "1280x720",
              },
            ],
          });
        }

        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeFetches -= 1;

        if (url === "https://example.com/720p.m3u8") {
          return createInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            segments: [
              { uri: "seg-1.ts", url: "https://example.com/seg-1.ts", duration: 6 },
              { uri: "seg-2.ts", url: "https://example.com/seg-2.ts", duration: 6.1 },
            ],
            targetDuration: 6,
          });
        }

        return createInspectResult({
          url,
          finalUrl: url,
          playlistType: "media",
          variants: [],
          segments: [
            { uri: "seg-a.ts", url: "https://example.com/seg-a.ts", duration: 10.7 },
          ],
          targetDuration: 10,
        });
      },
    });

    const result = await service.audit({
      url: "https://example.com/master.m3u8",
      followVariants: true,
    });

    expect(result.stats.variantsAudited).toBe(2);
    expect(result.variantAudits).toHaveLength(2);
    expect(result.aggregateIssues.map((issue) => issue.code)).toContain("inconsistent_target_duration");
    expect(result.aggregateIssues.map((issue) => issue.code)).toContain("duplicate_resolution_variants");
    expect(result.aggregateIssues.map((issue) => issue.code)).toContain("codec_family_inconsistency");
    expect(result.variantAudits[1]?.issues.map((issue) => issue.code)).toContain("segment_exceeds_target_duration");
    expect(result.ok).toBe(false);
    expect(maxActiveFetches).toBe(1);
  });

  it("mantem o relatorio quando uma variant falha no fetch", async () => {
    const service = new ManifestAudit({
      inspectHls: async ({ url }) => {
        if (url === "https://example.com/master.m3u8") {
          return createInspectResult();
        }
        throw new Error(`fetch failed for ${url}: HTTP 502`);
      },
    });

    const result = await service.audit({
      url: "https://example.com/master.m3u8",
      followVariants: true,
      maxVariants: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.stats.variantsAudited).toBe(1);
    expect(result.variantAudits[0]?.issues[0]?.code).toBe("inspect_error");
    expect(result.variantAudits[0]?.issues[0]?.evidence).toContain("url=https://example.com/720p.m3u8");
    expect(result.variantAudits[0]?.issues[0]?.evidence.at(-1)).toContain("HTTP 502");
  });
});
