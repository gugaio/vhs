import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaInspector } from "../src/inspect.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaInspector", () => {
  it("captura atributos de EXT-X-MEDIA audio/subtitles e vinculos em variants", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          [
            "#EXTM3U",
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aacl-128",LANGUAGE="pt",NAME="Portuguese",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio-pt.m3u8"',
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="textstream",LANGUAGE="pt",NAME="Portuguese (caption)",AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog",URI="subs-pt.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=793000,CODECS="mp4a.40.2,avc1.4D401E",RESOLUTION=640x360,FRAME-RATE=23.976,AUDIO="audio-aacl-128",SUBTITLES="textstream",CLOSED-CAPTIONS=NONE',
            "video-360.m3u8",
          ].join("\n"),
        ),
    );

    const result = await new MediaInspector().inspectHls({
      url: "https://example.com/master.m3u8",
    });

    expect(result.renditions[0]).toMatchObject({
      type: "AUDIO",
      groupId: "audio-aacl-128",
      language: "pt",
      name: "Portuguese",
      default: true,
      autoselect: true,
      channels: "2",
      uri: "audio-pt.m3u8",
      url: "https://example.com/audio-pt.m3u8",
    });
    expect(result.renditions[1]).toMatchObject({
      type: "SUBTITLES",
      groupId: "textstream",
      language: "pt",
      name: "Portuguese (caption)",
      autoselect: true,
      characteristics: "public.accessibility.transcribes-spoken-dialog",
      uri: "subs-pt.m3u8",
      url: "https://example.com/subs-pt.m3u8",
    });
    expect(result.variants[0]).toMatchObject({
      audioGroupId: "audio-aacl-128",
      subtitlesGroupId: "textstream",
      closedCaptions: "NONE",
    });
  });

  it("captura EXT-X-MAP em media playlists fMP4", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:4",
            '#EXT-X-MAP:URI="init.mp4"',
            "#EXTINF:4.000,",
            "seg-0.m4s",
            "#EXTINF:4.000,",
            "seg-1.m4s",
            "#EXT-X-ENDLIST",
          ].join("\n"),
        ),
    );

    const result = await new MediaInspector().inspectHls({
      url: "https://example.com/video/index.m3u8",
      maxSegments: 2,
    });

    expect(result.playlistType).toBe("media");
    expect(result.map).toEqual({
      uri: "init.mp4",
      url: "https://example.com/video/init.mp4",
      byteRange: undefined,
    });
    expect(result.segments.map((segment) => segment.map?.url)).toEqual([
      "https://example.com/video/init.mp4",
      "https://example.com/video/init.mp4",
    ]);
  });

  it("inspeciona MPD DASH com SegmentTemplate e SegmentTimeline", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<MPD type="static" mediaPresentationDuration="PT12S" minBufferTime="PT1.5S">',
            "  <Period>",
            '    <AdaptationSet id="v" contentType="video" mimeType="video/mp4" codecs="avc1.4d401f">',
            '      <SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.mp4" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="7">',
            "        <SegmentTimeline>",
            '          <S t="0" d="4000" r="2"/>',
            "        </SegmentTimeline>",
            "      </SegmentTemplate>",
            '      <Representation id="720p" bandwidth="1800000" width="1280" height="720" frameRate="24000/1001"/>',
            "    </AdaptationSet>",
            "  </Period>",
            "</MPD>",
          ].join("\n"),
        ),
    );

    const result = await new MediaInspector().inspectDash({
      url: "https://example.com/dash/manifest.mpd",
      maxSegments: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.mediaPresentationDurationSeconds).toBe(12);
    expect(result.representations[0]).toMatchObject({
      id: "720p",
      contentType: "video",
      mimeType: "video/mp4",
      codecs: "avc1.4d401f",
      bandwidth: 1_800_000,
      width: 1280,
      height: 720,
    });
    expect(result.representations[0].initialization).toEqual({
      uri: "init-720p.mp4",
      url: "https://example.com/dash/init-720p.mp4",
    });
    expect(result.representations[0].segments.map((segment) => [segment.uri, segment.duration, segment.number])).toEqual([
      ["chunk-720p-00007.m4s", 4, 7],
      ["chunk-720p-00008.m4s", 4, 8],
      ["chunk-720p-00009.m4s", 4, 9],
    ]);
  });
});
