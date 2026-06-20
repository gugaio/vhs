import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DashInspectResult, HlsInspectResult } from "../src/inspect.js";
import { diagnoseStreamerClone } from "../src/stream/diagnostics.js";
import { renderStreamerAnalysisHtml } from "../src/stream/report-html.js";
import { StreamerService } from "../src/stream/service.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vhs-streamer-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function makeInspectResult(overrides: Partial<HlsInspectResult> = {}): HlsInspectResult {
  return {
    ok: true,
    url: "https://example.com/master.m3u8",
    finalUrl: "https://example.com/master.m3u8",
    playlistType: "master",
    variants: [],
    renditions: [],
    segments: [],
    discontinuityMarkers: [],
    errors: [],
    ...overrides,
  };
}

function makeDashInspectResult(overrides: Partial<DashInspectResult> = {}): DashInspectResult {
  return {
    ok: true,
    url: "https://example.com/manifest.mpd",
    finalUrl: "https://example.com/manifest.mpd",
    type: "static",
    representations: [],
    errors: [],
    ...overrides,
  };
}

describe("StreamerService", () => {
  it("seleciona a variant de maior bandwidth e baixa segmentos ate cumulative >= alvo", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const progressTypes: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "low.m3u8",
                  url: "https://example.com/low.m3u8",
                  bandwidth: 800_000,
                  resolution: "640x360",
                },
                {
                  uri: "high.m3u8",
                  url: "https://example.com/high.m3u8",
                  bandwidth: 2_500_000,
                  resolution: "1280x720",
                },
              ],
            });
          }

          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 4,
            mediaSequence: 10,
            segments: [
              { uri: "seg-10.ts", url: "https://cdn.example.com/seg-10.ts", duration: 4 },
              { uri: "seg-11.ts", url: "https://cdn.example.com/seg-11.ts", duration: 4 },
              { uri: "seg-12.ts", url: "https://cdn.example.com/seg-12.ts", duration: 4 },
              { uri: "seg-13.ts", url: "https://cdn.example.com/seg-13.ts", duration: 4 },
            ],
          });
        },
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new Uint8Array([1, 2, 3]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 10,
      originId: "fixture-origin",
      onProgress: (event) => {
        progressTypes.push(event.type);
      },
    });

    expect(result.id).toBe("fixture-origin");
    expect(result.schemaVersion).toBe(2);
    expect(result.allVariants).toBe(false);
    expect(result.variantCount).toBe(1);
    expect(result.selectedUrl).toBe("https://example.com/high.m3u8");
    expect(result.selectedVariant?.resolution).toBe("1280x720");
    expect(result.segmentCount).toBe(3);
    expect(result.cumulativeDurationSeconds).toBe(12);
    expect(result.reachedTargetDuration).toBe(true);
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/seg-10.ts",
      "https://cdn.example.com/seg-11.ts",
      "https://cdn.example.com/seg-12.ts",
    ]);
    expect(progressTypes).toContain("start");
    expect(progressTypes).toContain("manifest_fetch");
    expect(progressTypes).toContain("variant_ready");
    expect(progressTypes.filter((type) => type === "segment_downloaded")).toHaveLength(3);
    expect(progressTypes.at(-1)).toBe("complete");

    const manifest = await fs.readFile(result.manifestPath, "utf-8");
    expect(manifest).toContain("#EXT-X-MEDIA-SEQUENCE:10");
    expect(manifest).toContain("segments/00000-seg-10.ts");
    expect(manifest).toContain("#EXT-X-ENDLIST");
    await expect(fs.stat(path.join(result.rootDir, "segments", "00002-seg-12.ts"))).resolves.toBeTruthy();
  });

  it("clona uma janela a partir de um offset aproximado", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            mediaSequence: 20,
            segments: Array.from({ length: 8 }, (_, index) => ({
              uri: `seg-${index}.ts`,
              url: `https://cdn.example.com/seg-${index}.ts`,
              duration: 4,
            })),
          }),
        probe: async ({ input }) => ({
          ok: true,
          input,
          timeoutMs: 5000,
          format: { duration: "4.000" },
          streams: [{ codec_type: "video", codec_name: "h264" }],
          timeline: {
            streamSelector: "v:0",
            sampleKind: "frames",
            sampleCount: 96,
            firstPtsTime: 0,
            lastPtsTime: 4,
            keyframeCount: 1,
            startsWithKeyframe: true,
            maxKeyframeGapSeconds: 1,
          },
          errors: [],
        }),
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new Uint8Array([1, 2, 3]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      startSeconds: 10,
      durationSeconds: 8,
      originId: "window-origin",
    });

    expect(result.requestedStartSeconds).toBe(10);
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/seg-2.ts",
      "https://cdn.example.com/seg-3.ts",
      "https://cdn.example.com/seg-4.ts",
    ]);
    expect(result.segments.map((segment) => [segment.originalIndex, segment.timelineStartSeconds, segment.timelineEndSeconds])).toEqual([
      [2, 8, 12],
      [3, 12, 16],
      [4, 16, 20],
    ]);

    const report = await service.analyzeOrigin(result.id, { full: true });
    expect(report.entries.map((entry) => [entry.segmentIndex, entry.timelineStartSeconds, entry.timelineEndSeconds])).toEqual([
      [0, 8, 12],
      [1, 12, 16],
      [2, 16, 20],
    ]);
    expect(renderStreamerAnalysisHtml(report)).toContain("8.000s -> 12.000s");
    expect(renderStreamerAnalysisHtml(report)).toContain("0:08 -> 0:12");
  });

  it("clona os proximos segmentos a partir de um indice original sem ficar limitado aos 200 primeiros", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const requestedMaxSegments: number[] = [];
    const downloadedOriginalIndexes: number[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url, maxSegments }) => {
          requestedMaxSegments.push(maxSegments ?? 0);
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            mediaSequence: 0,
            segments: Array.from({ length: Math.min(maxSegments ?? 20, 260) }, (_, index) => ({
              uri: `seg-${index}.ts`,
              url: `https://cdn.example.com/seg-${index}.ts`,
              duration: 4,
            })),
          });
        },
        probe: async ({ input }) => ({
          ok: true,
          input,
          timeoutMs: 5000,
          format: { duration: "4.000" },
          streams: [{ codec_type: "video", codec_name: "h264" }],
          timeline: {
            streamSelector: "v:0",
            sampleKind: "frames",
            sampleCount: 96,
            firstPtsTime: 0,
            lastPtsTime: 4,
            keyframeCount: 1,
            startsWithKeyframe: true,
            maxKeyframeGapSeconds: 1,
          },
          errors: [],
        }),
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new Uint8Array([1, 2, 3]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      startSegment: 200,
      segmentCount: 50,
      originId: "segment-window-origin",
      onProgress: (event) => {
        if (event.type === "segment_downloaded" && event.originalSegmentIndex !== undefined) {
          downloadedOriginalIndexes.push(event.originalSegmentIndex);
        }
      },
    });

    expect(requestedMaxSegments).toEqual([250]);
    expect(fetchedUrls).toHaveLength(50);
    expect(fetchedUrls[0]).toBe("https://cdn.example.com/seg-200.ts");
    expect(fetchedUrls.at(-1)).toBe("https://cdn.example.com/seg-249.ts");
    expect(result.requestedStartSegment).toBe(200);
    expect(result.requestedSegmentCount).toBe(50);
    expect(result.segmentCount).toBe(50);
    expect(result.segments[0]?.originalIndex).toBe(200);
    expect(result.segments.at(-1)?.originalIndex).toBe(249);
    expect(downloadedOriginalIndexes[0]).toBe(200);
    expect(downloadedOriginalIndexes.at(-1)).toBe(249);

    const report = await service.analyzeOrigin(result.id, {
      full: true,
      startSegment: 220,
      segmentCount: 5,
    });
    expect(report.entries).toHaveLength(5);
    expect(report.entries.map((entry) => [entry.segmentIndex, entry.originalSegmentIndex])).toEqual([
      [20, 220],
      [21, 221],
      [22, 222],
      [23, 223],
      [24, 224],
    ]);
  });

  it("clona todas as variants e gera uma master local quando allVariants esta ativo", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "low/playlist.m3u8",
                  url: "https://example.com/low/playlist.m3u8",
                  bandwidth: 700_000,
                  resolution: "640x360",
                  codecs: "avc1.4d401e,mp4a.40.2",
                },
                {
                  uri: "high/playlist.m3u8",
                  url: "https://example.com/high/playlist.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  codecs: "avc1.4d401f,mp4a.40.2",
                },
              ],
            });
          }

          const isHigh = url.includes("/high/");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 5,
            mediaSequence: 20,
            segments: [
              {
                uri: "seg-20.ts",
                url: `https://cdn.example.com/${isHigh ? "high" : "low"}/seg-20.ts`,
                duration: 5,
              },
              {
                uri: "seg-21.ts",
                url: `https://cdn.example.com/${isHigh ? "high" : "low"}/seg-21.ts`,
                duration: 5,
              },
            ],
          });
        },
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new Uint8Array([1, 2]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 8,
      originId: "all-variants-origin",
      allVariants: true,
    });

    expect(result.allVariants).toBe(true);
    expect(result.variantCount).toBe(2);
    expect(result.segmentCount).toBe(4);
    expect(result.cumulativeDurationSeconds).toBe(10);
    expect(result.bytes).toBe(8);
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/low/seg-20.ts",
      "https://cdn.example.com/low/seg-21.ts",
      "https://cdn.example.com/high/seg-20.ts",
      "https://cdn.example.com/high/seg-21.ts",
    ]);

    const master = await fs.readFile(result.manifestPath, "utf-8");
    expect(master).toContain("#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360");
    expect(master).toContain("variants/000-640x360/index.m3u8");
    expect(master).toContain("variants/001-1280x720/index.m3u8");

    const lowManifest = await fs.readFile(path.join(result.rootDir, "variants", "000-640x360", "index.m3u8"), "utf-8");
    expect(lowManifest).toContain("#EXT-X-MEDIA-SEQUENCE:20");
    expect(lowManifest).toContain("segments/00000-seg-20.ts");
    await expect(
      fs.stat(path.join(result.rootDir, "variants", "001-1280x720", "segments", "00001-seg-21.ts")),
    ).resolves.toBeTruthy();
  });

  it("preserva EXT-X-MAP baixando init segment local para fMP4", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 4,
            mediaSequence: 30,
            map: {
              uri: "init.mp4",
              url: "https://cdn.example.com/init.mp4",
            },
            segments: [
              {
                uri: "seg-30.m4s",
                url: "https://cdn.example.com/seg-30.m4s",
                duration: 4,
                map: {
                  uri: "init.mp4",
                  url: "https://cdn.example.com/init.mp4",
                },
              },
              {
                uri: "seg-31.m4s",
                url: "https://cdn.example.com/seg-31.m4s",
                duration: 4,
                map: {
                  uri: "init.mp4",
                  url: "https://cdn.example.com/init.mp4",
                },
              },
            ],
          }),
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        if (String(input).endsWith("/init.mp4")) {
          return new Response(new Uint8Array([9, 9, 9, 9]));
        }
        return new Response(new Uint8Array([1, 2]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      durationSeconds: 8,
      originId: "fmp4-origin",
    });

    expect(result.bytes).toBe(8);
    expect(result.variants[0].maps).toHaveLength(1);
    expect(result.variants[0].maps[0]).toMatchObject({
      sourceUrl: "https://cdn.example.com/init.mp4",
      localUri: "init/00000-init.mp4",
      bytes: 4,
    });
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/seg-30.m4s",
      "https://cdn.example.com/init.mp4",
      "https://cdn.example.com/seg-31.m4s",
    ]);

    const manifest = await fs.readFile(result.manifestPath, "utf-8");
    expect(manifest).toContain('#EXT-X-MAP:URI="init/00000-init.mp4"');
    expect(manifest.match(/#EXT-X-MAP/g)).toHaveLength(1);
    expect(manifest).toContain("segments/00000-seg-30.m4s");
    await expect(fs.stat(path.join(result.rootDir, "init", "00000-init.mp4"))).resolves.toBeTruthy();

    const handle = await service.serveLiveOrigin(result.id, {
      windowSize: 1,
      initialMediaSequence: 70,
    });
    try {
      const liveManifest = await fetch(handle.playbackUrl).then((response) => response.text());
      expect(liveManifest).toContain('#EXT-X-MAP:URI="/live/0/init/00000-init.mp4"');
      const initBytes = await fetch(`${handle.baseUrl}/live/0/init/00000-init.mp4`).then((response) =>
        response.arrayBuffer(),
      );
      expect(new Uint8Array(initBytes)).toEqual(new Uint8Array([9, 9, 9, 9]));
    } finally {
      await handle.close();
    }
  });

  it("clona renditions externas de audio e subtitles referenciadas pela master playlist", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video-720.m3u8",
                  url: "https://example.com/video-720.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  frameRate: 23.976,
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio-aacl-128",
                  subtitlesGroupId: "textstream",
                  closedCaptions: "NONE",
                },
                {
                  uri: "video-720-ec3.m3u8",
                  url: "https://example.com/video-720-ec3.m3u8",
                  bandwidth: 2_400_000,
                  resolution: "1280x720",
                  frameRate: 23.976,
                  codecs: "ec-3,avc1.4D401F",
                  audioGroupId: "audio-ec-3-448",
                  subtitlesGroupId: "textstream",
                  closedCaptions: "NONE",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio-aacl-128",
                  language: "pt",
                  name: "Portuguese",
                  default: true,
                  autoselect: true,
                  channels: "2",
                  uri: "audio-pt.m3u8",
                  url: "https://example.com/audio-pt.m3u8",
                },
                {
                  type: "AUDIO",
                  groupId: "audio-aacl-128",
                  language: "pt",
                  name: "Portuguese (description)",
                  autoselect: true,
                  characteristics: "public.accessibility.describes-video",
                  channels: "2",
                  uri: "audio-desc.m3u8",
                  url: "https://example.com/audio-desc.m3u8",
                },
                {
                  type: "SUBTITLES",
                  groupId: "textstream",
                  language: "pt",
                  name: "Portuguese (caption)",
                  uri: "subs-pt.m3u8",
                  url: "https://example.com/subs-pt.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio-");
          const isSubtitle = url.includes("subs-");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 4,
            mediaSequence: isAudio ? 200 : isSubtitle ? 300 : 100,
            segments: [
              {
                uri: isAudio ? "audio-0.aac" : isSubtitle ? "subs-0.vtt" : "video-0.ts",
                url: isAudio
                  ? `${url}/audio-0.aac`
                  : isSubtitle
                  ? `${url}/subs-0.vtt`
                  : "https://cdn.example.com/video-0.ts",
                duration: 4,
              },
              {
                uri: isAudio ? "audio-1.aac" : isSubtitle ? "subs-1.vtt" : "video-1.ts",
                url: isAudio
                  ? `${url}/audio-1.aac`
                  : isSubtitle
                  ? `${url}/subs-1.vtt`
                  : "https://cdn.example.com/video-1.ts",
                duration: 4,
              },
            ],
          });
        },
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new TextEncoder().encode(String(input)));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 8,
      originId: "audio-renditions-origin",
    });

    expect(result.variantCount).toBe(1);
    expect(result.selectedVariant?.audioGroupId).toBe("audio-aacl-128");
    expect(result.selectedVariant?.codecs).toBe("mp4a.40.2,avc1.4D401F");
    expect(result.selectedVariant?.subtitlesGroupId).toBe("textstream");
    expect(result.renditionCount).toBe(3);
    const diagnostic = diagnoseStreamerClone(result);
    expect(diagnostic.browserCompatibility).toBe("yes");
    expect(diagnostic.audioCodecs).toEqual(["mp4a.40.2"]);
    expect(diagnostic.externalAudio).toBe(true);
    expect(diagnostic.externalSubtitles).toBe(true);
    expect(diagnostic.audioRenditionCount).toBe(2);
    expect(diagnostic.subtitleRenditionCount).toBe(1);
    expect(result.renditions.map((rendition) => rendition.name)).toEqual([
      "Portuguese",
      "Portuguese (description)",
      "Portuguese (caption)",
    ]);
    expect(result.renditions.map((rendition) => rendition.type)).toEqual(["AUDIO", "AUDIO", "SUBTITLES"]);
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/video-0.ts",
      "https://cdn.example.com/video-1.ts",
      "https://example.com/audio-pt.m3u8/audio-0.aac",
      "https://example.com/audio-pt.m3u8/audio-1.aac",
      "https://example.com/audio-desc.m3u8/audio-0.aac",
      "https://example.com/audio-desc.m3u8/audio-1.aac",
      "https://example.com/subs-pt.m3u8/subs-0.vtt",
      "https://example.com/subs-pt.m3u8/subs-1.vtt",
    ]);

    const master = await fs.readFile(result.manifestPath, "utf-8");
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aacl-128",LANGUAGE="pt",NAME="Portuguese",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/000-audio-aacl-128-Portuguese/index.m3u8"');
    expect(master).toContain('CHARACTERISTICS="public.accessibility.describes-video"');
    expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="textstream",LANGUAGE="pt",NAME="Portuguese (caption)",URI="subtitles/000-textstream-Portuguese--caption-/index.m3u8"');
    expect(master).toContain('AUDIO="audio-aacl-128"');
    expect(master).toContain('SUBTITLES="textstream"');
    expect(master).toContain("CLOSED-CAPTIONS=NONE");
    expect(master).toContain("variants/000-1280x720/index.m3u8");

    const audioManifest = await fs.readFile(
      path.join(result.rootDir, "audio", "000-audio-aacl-128-Portuguese", "index.m3u8"),
      "utf-8",
    );
    expect(audioManifest).toContain("#EXT-X-MEDIA-SEQUENCE:200");
    expect(audioManifest).toContain("segments/00000-audio-0.aac");
    const subtitleManifest = await fs.readFile(
      path.join(result.rootDir, "subtitles", "000-textstream-Portuguese--caption-", "index.m3u8"),
      "utf-8",
    );
    expect(subtitleManifest).toContain("#EXT-X-MEDIA-SEQUENCE:300");
    expect(subtitleManifest).toContain("segments/00000-subs-0.vtt");

    const handle = await service.serveLiveOrigin(result.id, {
      windowSize: 1,
      initialMediaSequence: 80,
    });
    try {
      const liveMaster = await fetch(handle.playbackUrl).then((response) => response.text());
      expect(liveMaster).toContain('URI="/live/audio/0/index.m3u8"');
      expect(liveMaster).toContain('URI="/live/subtitles/0/index.m3u8"');
      expect(liveMaster).toContain('AUDIO="audio-aacl-128"');
      expect(liveMaster).toContain('SUBTITLES="textstream"');

      const liveAudio = await fetch(`${handle.baseUrl}/live/audio/0/index.m3u8`).then((response) =>
        response.text(),
      );
      expect(liveAudio).toContain("#EXT-X-MEDIA-SEQUENCE:80");
      const audioSegmentPath = liveAudio
        .split("\n")
        .find((line) => line.startsWith("/live/audio/0/segments/"));
      expect(audioSegmentPath).toBeDefined();
      const audioSegment = await fetch(`${handle.baseUrl}${audioSegmentPath}`).then((response) => response.text());
      expect(audioSegment).toContain("https://example.com/audio-pt.m3u8/");

      const liveSubtitle = await fetch(`${handle.baseUrl}/live/subtitles/0/index.m3u8`).then((response) =>
        response.text(),
      );
      expect(liveSubtitle).toContain("#EXT-X-MEDIA-SEQUENCE:80");
      const subtitleSegmentPath = liveSubtitle
        .split("\n")
        .find((line) => line.startsWith("/live/subtitles/0/segments/"));
      expect(subtitleSegmentPath).toBeDefined();
      const subtitleSegmentResponse = await fetch(`${handle.baseUrl}${subtitleSegmentPath}`);
      expect(subtitleSegmentResponse.headers.get("content-type")).toContain("text/vtt");
      const subtitleSegment = await subtitleSegmentResponse.text();
      expect(subtitleSegment).toContain("https://example.com/subs-pt.m3u8/");
    } finally {
      await handle.close();
    }
  });

  it("faz retry de download de segmento antes de falhar o clone", async () => {
    const root = await makeTempRoot();
    let attempts = 0;
    const progressTypes: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            segments: [
              { uri: "seg.ts", url: "https://cdn.example.com/seg.ts", duration: 4 },
            ],
          }),
      },
      root,
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("This operation was aborted");
        }
        return new Response(new Uint8Array([1, 2, 3]));
      },
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      durationSeconds: 4,
      originId: "retry-origin",
      segmentRetries: 1,
      segmentTimeoutMs: 1000,
      onProgress: (event) => {
        progressTypes.push(event.type);
      },
    });

    expect(attempts).toBe(2);
    expect(result.segmentCount).toBe(1);
    expect(progressTypes).toContain("segment_download_retry");
    expect(progressTypes).toContain("segment_downloaded");
  });

  it("lista, inspeciona e remove origins clonados", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            segments: [
              { uri: "seg-0.ts", url: "https://cdn.example.com/seg-0.ts", duration: 4 },
              { uri: "seg-1.ts", url: "https://cdn.example.com/seg-1.ts", duration: 4 },
            ],
          }),
      },
      root,
      async () => new Response(new Uint8Array([1, 2])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      durationSeconds: 8,
      originId: "managed-origin",
    });

    const origins = await service.listOrigins();
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({
      id: "managed-origin",
      schemaVersion: 2,
      segmentCount: 2,
      variantCount: 1,
      bytes: 4,
      allVariants: false,
    });

    const inspected = await service.inspectOrigin("managed-origin");
    expect(inspected.id).toBe("managed-origin");
    expect(inspected.rootDir).toBe(result.rootDir);
    expect(inspected.variants).toHaveLength(1);
    expect(inspected.variants[0].segments).toHaveLength(2);

    const removed = await service.removeOrigin("managed-origin");
    expect(removed).toEqual({
      id: "managed-origin",
      rootDir: result.rootDir,
      removed: true,
    });
    await expect(fs.stat(result.rootDir)).rejects.toThrow();
    await expect(service.listOrigins()).resolves.toEqual([]);
  });

  it("cria origin derivado com fault de discontinuity sem alterar o original", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            segments: [
              { uri: "seg-0.ts", url: "https://cdn.example.com/seg-0.ts", duration: 4 },
              { uri: "seg-1.ts", url: "https://cdn.example.com/seg-1.ts", duration: 4 },
              { uri: "seg-2.ts", url: "https://cdn.example.com/seg-2.ts", duration: 4 },
            ],
          }),
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const original = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      durationSeconds: 12,
      originId: "source-origin",
    });
    const mutated = await service.mutateOrigin({
      originId: original.id,
      fault: "discontinuity",
      targetKind: "variant",
      targetIndex: 0,
      segmentIndex: 1,
      newOriginId: "fault-origin",
    });

    expect(mutated.sourceOriginId).toBe("source-origin");
    expect(mutated.origin.id).toBe("fault-origin");
    expect(mutated.origin.derivedFrom).toBe("source-origin");
    expect(mutated.origin.faults).toEqual([
      expect.objectContaining({
        type: "discontinuity",
        targetKind: "variant",
        targetIndex: 0,
        segmentIndex: 1,
      }),
    ]);
    expect(mutated.origin.rootDir).toBe(path.join(root, "fault-origin"));
    expect(mutated.origin.variants[0].manifestPath).toBe(path.join(root, "fault-origin", "index.m3u8"));

    const originalManifest = await fs.readFile(original.manifestPath, "utf-8");
    const mutatedManifest = await fs.readFile(mutated.origin.variants[0].manifestPath, "utf-8");
    expect(originalManifest).not.toContain("#EXT-X-DISCONTINUITY");
    expect(mutatedManifest).toContain("#EXT-X-DISCONTINUITY\n#EXTINF:4.000,\nsegments/00001-seg-1.ts");

    const origins = await service.listOrigins();
    const faultSummary = origins.find((origin) => origin.id === "fault-origin");
    expect(faultSummary).toMatchObject({
      derivedFrom: "source-origin",
      faults: [
        expect.objectContaining({
          type: "discontinuity",
          segmentIndex: 1,
        }),
      ],
    });
  });

  it("cria origin derivado com fault de segment-swap usando donor origin", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: url.includes("donor") ? 6 : 4,
            segments: url.includes("donor")
              ? [
                  { uri: "donor-0.ts", url: "https://cdn.example.com/donor-0.ts", duration: 6 },
                  { uri: "donor-1.ts", url: "https://cdn.example.com/donor-1.ts", duration: 5.5 },
                ]
              : [
                  { uri: "base-0.ts", url: "https://cdn.example.com/base-0.ts", duration: 4 },
                  { uri: "base-1.ts", url: "https://cdn.example.com/base-1.ts", duration: 4 },
                  { uri: "base-2.ts", url: "https://cdn.example.com/base-2.ts", duration: 4 },
                ],
          }),
      },
      root,
      async (input) => {
        const url = String(input);
        if (url.includes("donor-1")) {
          return new Response(new TextEncoder().encode("DONOR-SEGMENT-1"));
        }
        if (url.includes("donor-0")) {
          return new Response(new TextEncoder().encode("DONOR-SEGMENT-0"));
        }
        return new Response(new TextEncoder().encode(`BASE:${url}`));
      },
    );
    await service.init();

    const base = await service.cloneHls({
      url: "https://example.com/base.m3u8",
      durationSeconds: 12,
      originId: "base-origin",
    });
    const donor = await service.cloneHls({
      url: "https://example.com/donor.m3u8",
      durationSeconds: 12,
      originId: "donor-origin",
    });

    const mutated = await service.mutateOrigin({
      originId: base.id,
      fault: "segment-swap",
      targetKind: "variant",
      targetIndex: 0,
      segmentIndex: 1,
      donorOriginId: donor.id,
      donorTargetKind: "variant",
      donorTargetIndex: 0,
      donorSegmentIndex: 1,
      withDiscontinuity: true,
      newOriginId: "swap-origin",
    });

    expect(mutated.origin.id).toBe("swap-origin");
    expect(mutated.origin.derivedFrom).toBe("base-origin");
    expect(mutated.fault).toMatchObject({
      type: "segment-swap",
      donorOriginId: "donor-origin",
      donorTargetKind: "variant",
      donorTargetIndex: 0,
      donorSegmentIndex: 1,
      withDiscontinuity: true,
    });
    expect((mutated.origin.faults ?? []).at(-1)).toMatchObject({
      type: "segment-swap",
      donorOriginId: "donor-origin",
    });

    const swappedSegmentPath = path.join(mutated.origin.rootDir, "segments", "00001-base-1.ts");
    await expect(fs.readFile(swappedSegmentPath, "utf-8")).resolves.toBe("DONOR-SEGMENT-1");

    const mutatedManifest = await fs.readFile(mutated.origin.manifestPath, "utf-8");
    expect(mutatedManifest).toContain("#EXT-X-DISCONTINUITY\n#EXTINF:5.500,\nsegments/00001-base-1.ts");
    expect(mutated.origin.variants[0].segments[1]).toMatchObject({
      sourceUri: "donor-1.ts",
      duration: 5.5,
    });
    expect(mutated.origin.targetDuration).toBe(6);
  });

  it("agrega ffprobe amostrado sobre playlists locais de video e renditions", async () => {
    const root = await makeTempRoot();
    const probedInputs: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video-720.m3u8",
                  url: "https://example.com/video-720.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio-aacl-128",
                  subtitlesGroupId: "textstream",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio-aacl-128",
                  language: "pt",
                  name: "Portuguese",
                  uri: "audio-pt.m3u8",
                  url: "https://example.com/audio-pt.m3u8",
                },
                {
                  type: "SUBTITLES",
                  groupId: "textstream",
                  language: "pt",
                  name: "Portuguese (caption)",
                  uri: "subs-pt.m3u8",
                  url: "https://example.com/subs-pt.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio-");
          const isSubtitle = url.includes("subs-");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 4,
            segments: [
              {
                uri: isAudio ? "audio-0.aac" : isSubtitle ? "subs-0.vtt" : "video-0.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : isSubtitle ? "subs" : "video"}-0.bin`,
                duration: 4,
              },
              {
                uri: isAudio ? "audio-1.aac" : isSubtitle ? "subs-1.vtt" : "video-1.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : isSubtitle ? "subs" : "video"}-1.bin`,
                duration: 4,
              },
            ],
          });
        },
        probe: async ({ input }) => {
          probedInputs.push(input);
          return {
            ok: !input.includes("/subtitles/"),
            input,
            timeoutMs: 5000,
            streams: input.includes("/audio/")
              ? [{ codec_type: "audio" }]
              : input.includes("/subtitles/")
              ? []
              : [{ codec_type: "video" }, { codec_type: "audio" }],
            errors: input.includes("/subtitles/") ? ["subtitle playlist probe unsupported"] : [],
          };
        },
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 8,
      originId: "probe-origin",
    });

    const report = await service.probeOrigin(result.id, { maxMediaPlaylists: 8, timeoutMs: 5000 });

    expect(report.originId).toBe("probe-origin");
    expect(report.sampledMediaPlaylists).toBe(3);
    expect(report.totalMediaPlaylists).toBe(3);
    expect(report.ok).toBe(false);
    expect(report.okCount).toBe(2);
    expect(report.failedCount).toBe(1);
    expect(report.entries).toEqual([
      expect.objectContaining({
        kind: "variant",
        index: 0,
        type: "VIDEO",
        ok: true,
        streamCount: 2,
      }),
      expect.objectContaining({
        kind: "rendition",
        index: 0,
        type: "AUDIO",
        ok: true,
        streamCount: 1,
      }),
      expect.objectContaining({
        kind: "rendition",
        index: 1,
        type: "SUBTITLES",
        ok: false,
        streamCount: 0,
        errors: ["subtitle playlist probe unsupported"],
      }),
    ]);
    expect(probedInputs).toEqual(
      expect.arrayContaining([
        path.join(result.rootDir, "variants", "000-1280x720", "index.m3u8"),
        path.join(result.rootDir, "audio", "000-audio-aacl-128-Portuguese", "index.m3u8"),
        path.join(result.rootDir, "subtitles", "000-textstream-Portuguese--caption-", "index.m3u8"),
      ]),
    );
  });

  it("analisa segmentos amostrados para duracao, pts e keyframes", async () => {
    const root = await makeTempRoot();
    const analyzedInputs: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video-720.m3u8",
                  url: "https://example.com/video-720.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio-aacl-128",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio-aacl-128",
                  language: "pt",
                  name: "Portuguese",
                  uri: "audio-pt.m3u8",
                  url: "https://example.com/audio-pt.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio-");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            variants: [],
            targetDuration: 4,
            segments: [
              {
                uri: isAudio ? "audio-0.aac" : "video-0.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-0.bin`,
                duration: 4,
              },
              {
                uri: isAudio ? "audio-1.aac" : "video-1.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-1.bin`,
                duration: 4,
              },
              {
                uri: isAudio ? "audio-2.aac" : "video-2.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-2.bin`,
                duration: 4,
              },
            ],
          });
        },
        probe: async ({ input, streamSelector, timeline }) => {
          analyzedInputs.push(`${streamSelector}:${input}:${timeline ? "timeline" : "plain"}`);
          const isAudio = input.includes("/audio/");
          const segmentOffset = input.includes("-1.") ? 4 : input.includes("-2.") ? 8 : 0;
          return {
            ok: true,
            input,
            timeoutMs: 5000,
            format: {
              duration: isAudio ? "4.011" : "4.004",
            },
            streams: isAudio ? [{ codec_type: "audio" }] : [{ codec_type: "video" }, { codec_type: "audio" }],
            timeline: isAudio
              ? {
                  streamSelector: "a:0",
                  sampleKind: "packets",
                  sampleCount: 180,
                  firstPtsTime: 12.032,
                  lastPtsTime: 16.021,
                }
              : {
                  streamSelector: "v:0",
                  sampleKind: "frames",
                  sampleCount: 96,
                  firstPtsTime: 10.000 + segmentOffset,
                  lastPtsTime: 13.962 + segmentOffset,
                  keyframeCount: 2,
                  startsWithKeyframe: true,
                  maxKeyframeGapSeconds: 2.000,
                },
            errors: [],
          };
        },
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 12,
      originId: "analyze-origin",
    });

    const report = await service.analyzeOrigin(result.id, {
      maxMediaPlaylists: 4,
      maxSegmentsPerPlaylist: 3,
      timeoutMs: 5000,
    });

    expect(report.originId).toBe("analyze-origin");
    expect(report.sampledMediaPlaylists).toBe(2);
    expect(report.totalMediaPlaylists).toBe(2);
    expect(report.sampledSegments).toBe(6);
    expect(report.okSegments).toBe(6);
    expect(report.failedSegments).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.avAlignment).toMatchObject({
      status: "ok",
      comparedPairs: 3,
      maxDurationDeltaSeconds: expect.closeTo(0.007, 3),
    });
    expect(report.media).toEqual([
      expect.objectContaining({
        kind: "variant",
        mediaIndex: 0,
        type: "VIDEO",
        sampledSegments: 3,
        durationDeltaMaxSeconds: expect.closeTo(0.004, 3),
        boundaryStatus: "ok",
        boundaryDeltaMaxSeconds: expect.closeTo(0, 3),
        gopStatus: "ok",
        maxKeyframeGapSeconds: 2,
        startsWithKeyframeFailures: 0,
      }),
      expect.objectContaining({
        kind: "rendition",
        mediaIndex: 0,
        type: "AUDIO",
        sampledSegments: 3,
        durationDeltaMaxSeconds: expect.closeTo(0.011, 3),
        boundaryStatus: "reset",
      }),
    ]);
    expect(report.entries[0]).toMatchObject({
      kind: "variant",
      mediaIndex: 0,
      segmentIndex: 0,
      type: "VIDEO",
      declaredDurationSeconds: 4,
      actualDurationSeconds: 4.004,
      durationDeltaSeconds: expect.closeTo(0.004, 3),
      streamCount: 2,
      packetCount: 96,
      firstPtsTime: 10,
      lastPtsTime: 13.962,
      boundaryStatus: "unknown",
      keyframeCount: 2,
      startsWithKeyframe: true,
      maxKeyframeGapSeconds: 2,
      ok: true,
    });
    expect(report.entries[1]).toMatchObject({
      kind: "variant",
      segmentIndex: 1,
      boundaryStatus: "ok",
      boundaryDeltaSeconds: expect.closeTo(0, 3),
    });
    expect(report.entries[3]).toMatchObject({
      kind: "rendition",
      mediaIndex: 0,
      segmentIndex: 0,
      type: "AUDIO",
      actualDurationSeconds: 4.011,
      durationDeltaSeconds: expect.closeTo(0.011, 3),
      streamCount: 1,
      packetCount: 180,
      firstPtsTime: 12.032,
      lastPtsTime: 16.021,
      boundaryStatus: "unknown",
      ok: true,
    });
    expect(report.entries[4]).toMatchObject({
      kind: "rendition",
      segmentIndex: 1,
      boundaryStatus: "reset",
    });
    expect(analyzedInputs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("v:0:"),
        expect.stringContaining("a:0:"),
      ]),
    );
  });

  it("gera issues acionaveis quando analyze detecta anomalias", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video-720.m3u8",
                  url: "https://example.com/video-720.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio-aacl-128",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio-aacl-128",
                  name: "Portuguese",
                  uri: "audio-pt.m3u8",
                  url: "https://example.com/audio-pt.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio-");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            segments: [
              {
                uri: isAudio ? "audio-0.aac" : "video-0.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-0.bin`,
                duration: 4,
              },
              {
                uri: isAudio ? "audio-1.aac" : "video-1.ts",
                url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-1.bin`,
                duration: 4,
              },
            ],
          });
        },
        probe: async ({ input }) => {
          const isAudio = input.includes("/audio/");
          const isSecondSegment = input.includes("-1.");
          return {
            ok: true,
            input,
            timeoutMs: 5000,
            format: {
              duration: isAudio ? "4.800" : isSecondSegment ? "4.001" : "4.000",
            },
            streams: isAudio ? [{ codec_type: "audio" }] : [{ codec_type: "video" }],
            timeline: isAudio
              ? {
                  streamSelector: "a:0",
                  sampleKind: "packets",
                  sampleCount: 180,
                  firstPtsTime: isSecondSegment ? 4.000 : 0.000,
                  lastPtsTime: isSecondSegment ? 8.000 : 4.000,
                }
              : {
                  streamSelector: "v:0",
                  sampleKind: "frames",
                  sampleCount: 96,
                  firstPtsTime: isSecondSegment ? 14.500 : 10.000,
                  lastPtsTime: isSecondSegment ? 18.400 : 13.900,
                  keyframeCount: 1,
                  startsWithKeyframe: !isSecondSegment,
                  maxKeyframeGapSeconds: isSecondSegment ? 4.500 : 1.000,
                },
            errors: [],
          };
        },
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 8,
      originId: "analyze-issues-origin",
    });

    const report = await service.analyzeOrigin(result.id, {
      maxMediaPlaylists: 4,
      maxSegmentsPerPlaylist: 2,
      timeoutMs: 5000,
    });

    expect(report.ok).toBe(true);
    expect(report.avAlignment.status).toBe("warn");
    expect(report.media.find((item) => item.type === "VIDEO")).toMatchObject({
      boundaryStatus: "warn",
      gopStatus: "warn",
      startsWithKeyframeFailures: 1,
    });
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "duration_delta_high",
        "segment_boundary_gap",
        "segment_not_keyframe_aligned",
        "gop_unstable",
        "av_duration_drift",
      ]),
    );
    expect(report.issues.every((issue) => ["info", "warning", "error"].includes(issue.severity))).toBe(true);
  });

  it("destaca drift de timeline entre video e audio externo por janela", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video.m3u8",
                  url: "https://example.com/video.m3u8",
                  bandwidth: 2_000_000,
                  resolution: "1280x720",
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio",
                  name: "Portuguese",
                  uri: "audio.m3u8",
                  url: "https://example.com/audio.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio.");
          const durations = isAudio ? [6, 6, 6] : [6, 5, 6];
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 6,
            segments: durations.map((duration, index) => ({
              uri: `${isAudio ? "audio" : "video"}-${index}.${isAudio ? "aac" : "ts"}`,
              url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-${index}.bin`,
              duration,
            })),
          });
        },
        probe: async ({ input }) => {
          const isAudio = input.includes("/audio/");
          const isShortVideo = input.includes("video-1.ts");
          const duration = isAudio ? 6 : isShortVideo ? 5 : 6;
          return {
            ok: true,
            input,
            timeoutMs: 5000,
            format: { duration: duration.toFixed(3) },
            streams: isAudio ? [{ codec_type: "audio", codec_name: "aac" }] : [{ codec_type: "video", codec_name: "h264" }],
            timeline: {
              streamSelector: isAudio ? "a:0" : "v:0",
              sampleKind: isAudio ? "packets" : "frames",
              sampleCount: isAudio ? 258 : duration * 24,
              firstPtsTime: 0,
              lastPtsTime: duration,
              keyframeCount: isAudio ? undefined : 1,
              startsWithKeyframe: isAudio ? undefined : true,
              maxKeyframeGapSeconds: isAudio ? undefined : 1,
            },
            errors: [],
          };
        },
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 17,
      originId: "timeline-drift-origin",
    });

    const report = await service.analyzeOrigin(result.id, {
      full: true,
      maxMediaPlaylists: 4,
      timeoutMs: 5000,
    });

    expect(report.avAlignment.status).toBe("warn");
    expect(report.avAlignment.comparedTimelineWindows).toBe(3);
    expect(report.avAlignment.maxTimelineDriftSeconds).toBeCloseTo(1, 3);
    expect(report.avAlignment.timelineDriftWindows?.[0]).toMatchObject({
      status: "warn",
      videoSegmentIndex: 1,
      audioSegmentIndex: 1,
      videoDurationSeconds: 5,
      audioDurationSeconds: 6,
      endDeltaSeconds: 1,
      durationDeltaSeconds: 1,
    });
    expect(report.issues.map((issue) => issue.code)).toContain("av_timeline_window_drift");

    const html = renderStreamerAnalysisHtml(report);
    expect(html).toContain("A/V Timeline Drift");
    expect(html).toContain("0:06 -> 0:11");
    expect(html).toContain("+1.000s");
  });

  it("detecta audio timestamp discontinuity em modo full e renderiza no HTML", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "video.m3u8",
                  url: "https://example.com/video.m3u8",
                  bandwidth: 1_000_000,
                  codecs: "mp4a.40.2,avc1.4D401F",
                  audioGroupId: "audio",
                },
              ],
              renditions: [
                {
                  type: "AUDIO",
                  groupId: "audio",
                  name: "main",
                  uri: "audio.m3u8",
                  url: "https://example.com/audio.m3u8",
                },
              ],
            });
          }

          const isAudio = url.includes("audio");
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 1,
            segments: [0, 1, 2, 3].map((index) => ({
              uri: `${isAudio ? "audio" : "video"}-${index}.${isAudio ? "aac" : "ts"}`,
              url: `https://cdn.example.com/${isAudio ? "audio" : "video"}-${index}.bin`,
              duration: 0.5,
            })),
          });
        },
        probe: async ({ input }) => {
          const isAudio = input.includes("/audio/");
          const match = input.match(/0000(\d)-/);
          const segmentIndex = match ? Number(match[1]) : 0;
          const audioFirstPtsBySegment = [
            1_005_427.321322,
            1_005_427.821322,
            1_005_428.321322,
            1_005_429.221322,
          ];
          const firstPtsTime = isAudio ? audioFirstPtsBySegment[segmentIndex] : segmentIndex * 0.5;
          return {
            ok: true,
            input,
            timeoutMs: 5000,
            format: {
              duration: "0.500",
            },
            streams: isAudio
              ? [{ codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }]
              : [{ codec_type: "video", codec_name: "h264" }],
            timeline: {
              streamSelector: isAudio ? "a:0" : "v:0",
              sampleKind: isAudio ? "packets" : "frames",
              sampleCount: isAudio ? 24 : 15,
              firstPtsTime,
              lastPtsTime: firstPtsTime + 0.49,
              keyframeCount: isAudio ? undefined : 1,
              startsWithKeyframe: isAudio ? undefined : true,
              maxKeyframeGapSeconds: isAudio ? undefined : 0.5,
            },
            errors: [],
          };
        },
      },
      root,
      async () => new Response(new Uint8Array([1, 2, 3])),
    );
    await service.init();

    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 2,
      originId: "audio-gap-origin",
    });

    const report = await service.analyzeOrigin(result.id, {
      full: true,
      maxMediaPlaylists: 4,
      timeoutMs: 5000,
    });

    const audioEntries = report.entries.filter((entry) => entry.type === "AUDIO");
    expect(audioEntries).toHaveLength(4);
    expect(audioEntries[3]).toMatchObject({
      continuityStatus: "gap",
      nextExpectedPtsUs: 1005428821322,
      nextActualPtsUs: 1005429221322,
      nextDeltaUs: 400000,
      codecName: "aac",
      sampleRate: 48000,
      channels: 2,
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "audio_timestamp_discontinuity",
          summary: "audio timestamp gap is 400.000ms",
          evidence: expect.arrayContaining([
            "expected=1005428821322us",
            "actual=1005429221322us",
            "delta=400.000ms",
          ]),
        }),
      ]),
    );

    const html = renderStreamerAnalysisHtml(report);
    expect(html).toContain("Audio Timestamp Discontinuities");
    expect(html).toContain("audio_timestamp_discontinuity");
    expect(html).toContain("400.000ms");
    expect(html).toContain("279:17:09.221");
    expect(html).toContain("1005429221322us");
  });

  it("clona DASH com init segment, MPD local e analyze sobre os chunks", async () => {
    const root = await makeTempRoot();
    const fetchedUrls: string[] = [];
    const probeInputs: string[] = [];
    const service = new StreamerService(
      {
        inspectHls: async () => {
          throw new Error("HLS inspect should not be used for DASH clone");
        },
        inspectDash: async ({ url }) =>
          makeDashInspectResult({
            url,
            finalUrl: url,
            mediaPresentationDurationSeconds: 12,
            representations: [
              {
                id: "v1",
                adaptationSetId: "video",
                contentType: "video",
                mimeType: "video/mp4",
                codecs: "avc1.4d401f",
                bandwidth: 2_000_000,
                width: 1280,
                height: 720,
                frameRate: 24,
                baseUrl: "https://cdn.example.com/video/",
                initialization: {
                  uri: "init-v1.mp4",
                  url: "https://cdn.example.com/video/init-v1.mp4",
                },
                segments: [
                  { uri: "seg-1.m4s", url: "https://cdn.example.com/video/seg-1.m4s", duration: 4, number: 1 },
                  { uri: "seg-2.m4s", url: "https://cdn.example.com/video/seg-2.m4s", duration: 4, number: 2 },
                  { uri: "seg-3.m4s", url: "https://cdn.example.com/video/seg-3.m4s", duration: 4, number: 3 },
                ],
              },
              {
                id: "a1",
                adaptationSetId: "audio",
                contentType: "audio",
                mimeType: "audio/mp4",
                codecs: "mp4a.40.2",
                bandwidth: 128_000,
                audioSamplingRate: 48_000,
                lang: "pt",
                baseUrl: "https://cdn.example.com/audio/",
                initialization: {
                  uri: "init-a1.mp4",
                  url: "https://cdn.example.com/audio/init-a1.mp4",
                },
                segments: [
                  { uri: "aud-1.m4s", url: "https://cdn.example.com/audio/aud-1.m4s", duration: 4, number: 1 },
                  { uri: "aud-2.m4s", url: "https://cdn.example.com/audio/aud-2.m4s", duration: 4, number: 2 },
                  { uri: "aud-3.m4s", url: "https://cdn.example.com/audio/aud-3.m4s", duration: 4, number: 3 },
                ],
              },
            ],
        }),
        probe: async ({ input, streamSelector }) => {
          probeInputs.push(input);
          const probeBytes = await fs.readFile(input, "utf-8");
          const isSecondSegment = probeBytes.includes("seg-2.m4s") || probeBytes.includes("aud-2.m4s");
          const firstPtsTime = isSecondSegment ? 4 : 0;
          return {
            ok: true,
            input,
            timeoutMs: 5000,
            format: { duration: "4.000" },
            streams: [
              {
                codec_type: streamSelector === "a:0" ? "audio" : "video",
                codec_name: streamSelector === "a:0" ? "aac" : "h264",
              },
            ],
            timeline: {
              streamSelector: streamSelector ?? "v:0",
              sampleKind: streamSelector === "a:0" ? "packets" : "frames",
              sampleCount: 10,
              firstPtsTime,
              lastPtsTime: firstPtsTime + 3.979,
              lastSampleDurationTime: 0.021,
              keyframeCount: streamSelector === "a:0" ? undefined : 1,
              startsWithKeyframe: streamSelector === "a:0" ? undefined : true,
              maxKeyframeGapSeconds: streamSelector === "a:0" ? undefined : 1,
            },
            errors: [],
          };
        },
      },
      root,
      async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new TextEncoder().encode(String(input)));
      },
    );
    await service.init();

    const result = await service.cloneDash({
      url: "https://example.com/manifest.mpd",
      durationSeconds: 8,
      originId: "dash-origin",
    });

    expect(result.protocol).toBe("dash");
    expect(result.playbackPath).toBe("/index.mpd");
    expect(result.variantCount).toBe(1);
    expect(result.renditionCount).toBe(1);
    expect(result.segmentCount).toBe(2);
    expect(result.selectedVariant?.resolution).toBe("1280x720");
    expect(result.renditions[0]).toMatchObject({
      type: "AUDIO",
      id: "a1",
      language: "pt",
      codecs: "mp4a.40.2",
    });
    expect(fetchedUrls).toEqual([
      "https://cdn.example.com/video/init-v1.mp4",
      "https://cdn.example.com/video/seg-1.m4s",
      "https://cdn.example.com/video/seg-2.m4s",
      "https://cdn.example.com/audio/init-a1.mp4",
      "https://cdn.example.com/audio/aud-1.m4s",
      "https://cdn.example.com/audio/aud-2.m4s",
    ]);

    const mpd = await fs.readFile(result.manifestPath, "utf-8");
    expect(mpd).toContain("urn:mpeg:dash:schema:mpd:2011");
    expect(mpd).toContain('variants/000-video-1280x720-v1-2000000/init/00000-init-v1.mp4');
    expect(mpd).toContain('variants/000-video-1280x720-v1-2000000/segments/00000-seg-1.m4s');
    expect(mpd).toContain('contentType="audio"');
    expect(mpd).toContain('audio/000-audio-a1-128000/init/00000-init-a1.mp4');

    const origin = await service.inspectOrigin(result.id);
    expect(origin.protocol).toBe("dash");
    const report = await service.analyzeOrigin(result.id, { full: true });
    expect(report.sampledSegments).toBe(4);
    expect(report.issues.filter((issue) => issue.code === "duration_delta_high")).toHaveLength(0);
    expect(report.entries.map((entry) => entry.actualDurationSeconds)).toEqual([4, 4, 4, 4]);
    expect(probeInputs.filter((input) => input.includes("vhs-streamer-probe-"))).toHaveLength(4);
    await expect(fs.access(probeInputs[0])).rejects.toThrow();

    const handle = await service.serveOrigin(result.id);
    try {
      expect(handle.playbackUrl).toBe(`${handle.baseUrl}/index.mpd`);
      const response = await fetch(handle.playbackUrl);
      expect(response.headers.get("content-type")).toContain("application/dash+xml");
      expect(await response.text()).toContain("<MPD");
    } finally {
      await handle.close();
    }
  });

  it("serve o origin local com CORS", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) =>
          makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 6,
            segments: [
              { uri: "seg.ts", url: "https://cdn.example.com/seg.ts", duration: 6 },
            ],
          }),
      },
      root,
      async () => new Response(new Uint8Array([9, 8, 7])),
    );
    await service.init();
    const result = await service.cloneHls({
      url: "https://example.com/media.m3u8",
      durationSeconds: 6,
      originId: "served-origin",
    });
    const handle = await service.serveOrigin(result.id);

    try {
      const response = await fetch(handle.playbackUrl);
      const body = await response.text();
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(body).toContain("segments/00000-seg.ts");
    } finally {
      await handle.close();
    }
  });

  it("serve um clone all-variants como live sliding window", async () => {
    const root = await makeTempRoot();
    const service = new StreamerService(
      {
        inspectHls: async ({ url }) => {
          if (url === "https://example.com/master.m3u8") {
            return makeInspectResult({
              variants: [
                {
                  uri: "low.m3u8",
                  url: "https://example.com/low.m3u8",
                  bandwidth: 600_000,
                  resolution: "640x360",
                },
                {
                  uri: "high.m3u8",
                  url: "https://example.com/high.m3u8",
                  bandwidth: 1_800_000,
                  resolution: "1280x720",
                },
              ],
            });
          }

          const lane = url.includes("high") ? "high" : "low";
          return makeInspectResult({
            url,
            finalUrl: url,
            playlistType: "media",
            targetDuration: 4,
            segments: [
              { uri: "seg-0.ts", url: `https://cdn.example.com/${lane}/seg-0.ts`, duration: 4 },
              { uri: "seg-1.ts", url: `https://cdn.example.com/${lane}/seg-1.ts`, duration: 4 },
              { uri: "seg-2.ts", url: `https://cdn.example.com/${lane}/seg-2.ts`, duration: 4 },
            ],
          });
        },
      },
      root,
      async (input) => new Response(new TextEncoder().encode(String(input))),
    );
    await service.init();
    const result = await service.cloneHls({
      url: "https://example.com/master.m3u8",
      durationSeconds: 10,
      originId: "live-origin",
      allVariants: true,
    });
    const handle = await service.serveLiveOrigin(result.id, {
      windowSize: 3,
      initialMediaSequence: 50,
    });

    try {
      const master = await fetch(handle.playbackUrl).then((response) => response.text());
      expect(master).toContain("/live/0/index.m3u8");
      expect(master).toContain("/live/1/index.m3u8");

      const mediaResponse = await fetch(`${handle.baseUrl}/live/0/index.m3u8`);
      const media = await mediaResponse.text();
      expect(mediaResponse.headers.get("access-control-allow-origin")).toBe("*");
      expect(media).toContain("#EXT-X-MEDIA-SEQUENCE:50");
      expect(media).not.toContain("#EXT-X-ENDLIST");
      expect(media.match(/#EXTINF:/g)).toHaveLength(3);

      const segmentPath = media
        .split("\n")
        .find((line) => line.startsWith("/live/0/segments/"));
      expect(segmentPath).toBeDefined();
      const segmentResponse = await fetch(`${handle.baseUrl}${segmentPath}`);
      const segmentBody = await segmentResponse.text();
      expect(segmentResponse.headers.get("content-type")).toContain("video/mp2t");
      expect(segmentBody).toContain("https://cdn.example.com/low/");
    } finally {
      await handle.close();
    }
  });

});
