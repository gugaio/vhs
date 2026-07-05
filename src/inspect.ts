import { spawnSync } from "node:child_process";
import {
  attr,
  childNodes,
  fetchText,
  firstChild,
  firstChildText,
  localXmlName,
  numberAttr,
  parseAttrList,
  parseFrameRate,
  parseIsoDurationSeconds,
  parseXml,
  parseYesNoAttr,
  resolveUrl,
  validateStreamUrl,
} from "./inspect-support.js";
import type { XmlNode } from "./inspect-support.js";

type HlsVariant = {
  uri: string;
  url: string;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: string;
  frameRate?: number;
  codecs?: string;
  audioGroupId?: string;
  subtitlesGroupId?: string;
  closedCaptions?: string;
};

type HlsRendition = {
  type: string;
  groupId?: string;
  name?: string;
  language?: string;
  default?: boolean;
  autoselect?: boolean;
  forced?: boolean;
  channels?: string;
  characteristics?: string;
  uri?: string;
  url?: string;
};

type HlsMap = {
  uri: string;
  url: string;
  byteRange?: string;
};

type HlsSegment = {
  uri: string;
  url: string;
  duration?: number;
  title?: string;
  map?: HlsMap;
};

type DashSegment = {
  uri: string;
  url: string;
  duration?: number;
  number?: number;
  time?: number;
};

type DashInitialization = {
  uri: string;
  url: string;
};

type DashRepresentation = {
  id?: string;
  adaptationSetId?: string;
  contentType: "video" | "audio" | "text" | "unknown";
  mimeType?: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  audioSamplingRate?: number;
  lang?: string;
  baseUrl: string;
  initialization?: DashInitialization;
  segments: DashSegment[];
};

export type DashInspectResult = {
  ok: boolean;
  url: string;
  finalUrl: string;
  type?: "static" | "dynamic";
  profiles?: string;
  mediaPresentationDurationSeconds?: number;
  minBufferTimeSeconds?: number;
  representations: DashRepresentation[];
  errors: string[];
};

export type HlsInspectResult = {
  ok: boolean;
  url: string;
  finalUrl: string;
  playlistType: "master" | "media" | "unknown";
  variants: HlsVariant[];
  renditions: HlsRendition[];
  segments: HlsSegment[];
  map?: HlsMap;
  targetDuration?: number;
  mediaSequence?: number;
  /** Valor declarado em #EXT-X-DISCONTINUITY-SEQUENCE (se presente). */
  discontinuitySequence?: number;
  /** Índices (0-based) no array de segmentos onde apareceu #EXT-X-DISCONTINUITY. */
  discontinuityMarkers: number[];
  errors: string[];
};

export type ProbeResult = {
  ok: boolean;
  input: string;
  timeoutMs: number;
  format?: unknown;
  streams?: unknown[];
  keyframes?: {
    streamSelector: string;
    count: number;
    timestamps: number[];
  };
  timeline?: {
    streamSelector: string;
    sampleKind: "frames" | "packets";
    sampleCount: number;
    firstPtsTime?: number;
    lastPtsTime?: number;
    lastSampleDurationTime?: number;
    keyframeCount?: number;
    startsWithKeyframe?: boolean;
    maxKeyframeGapSeconds?: number;
  };
  errors: string[];
};

function inferDashContentType(attrs: Record<string, string>): DashRepresentation["contentType"] {
  const declared = (attrs.contentType ?? attrs.mimeType ?? attrs.MIMETYPE ?? "").toLowerCase();
  if (declared.includes("video")) return "video";
  if (declared.includes("audio")) return "audio";
  if (declared.includes("text") || declared.includes("subtitle") || declared.includes("vtt")) return "text";
  return "unknown";
}

function replaceDashTemplatePlaceholders(
  template: string,
  representation: DashRepresentation,
  number: number | undefined,
  time: number | undefined,
): string {
  return template.replace(/\$(RepresentationID|Bandwidth|Number(?:%0(\d+)d)?|Time)\$/g, (_full, key: string, width: string | undefined) => {
    if (key === "RepresentationID") {
      return representation.id ?? "";
    }
    if (key === "Bandwidth") {
      return String(representation.bandwidth ?? "");
    }
    if (key.startsWith("Number")) {
      const raw = String(number ?? "");
      const pad = width ? Number(width) : 0;
      return pad > 0 ? raw.padStart(pad, "0") : raw;
    }
    if (key === "Time") {
      return String(time ?? "");
    }
    return "";
  });
}

function buildDashTemplateInitialization(
  template: XmlNode,
  representation: DashRepresentation,
): DashInitialization | undefined {
  const raw = attr(template, "initialization");
  if (!raw) {
    return undefined;
  }
  const uri = replaceDashTemplatePlaceholders(raw, representation, undefined, undefined);
  return {
    uri,
    url: resolveUrl(representation.baseUrl, uri),
  };
}

function buildDashTemplateSegments(
  template: XmlNode,
  representation: DashRepresentation,
  maxSegments: number,
): DashSegment[] {
  const media = attr(template, "media");
  if (!media || maxSegments <= 0) {
    return [];
  }
  const timescale = numberAttr(template, "timescale") ?? 1;
  const startNumber = numberAttr(template, "startNumber") ?? 1;
  const timeline = firstChild(template, "SegmentTimeline");
  const segments: DashSegment[] = [];

  if (timeline) {
    let nextTime = 0;
    let nextNumber = startNumber;
    for (const s of childNodes(timeline, "S")) {
      const d = numberAttr(s, "d");
      if (!d || d <= 0) {
        continue;
      }
      const t = numberAttr(s, "t");
      if (typeof t === "number") {
        nextTime = t;
      }
      const repeat = Math.max(-1, Math.floor(numberAttr(s, "r") ?? 0));
      const count = repeat < 0 ? maxSegments - segments.length : repeat + 1;
      for (let index = 0; index < count && segments.length < maxSegments; index += 1) {
        const uri = replaceDashTemplatePlaceholders(media, representation, nextNumber, nextTime);
        segments.push({
          uri,
          url: resolveUrl(representation.baseUrl, uri),
          duration: d / timescale,
          number: nextNumber,
          time: nextTime,
        });
        nextNumber += 1;
        nextTime += d;
      }
      if (segments.length >= maxSegments) {
        break;
      }
    }
    return segments;
  }

  const duration = numberAttr(template, "duration");
  if (!duration || duration <= 0) {
    return [];
  }
  for (let index = 0; index < maxSegments; index += 1) {
    const number = startNumber + index;
    const time = index * duration;
    const uri = replaceDashTemplatePlaceholders(media, representation, number, time);
    segments.push({
      uri,
      url: resolveUrl(representation.baseUrl, uri),
      duration: duration / timescale,
      number,
      time,
    });
  }
  return segments;
}

function buildDashListInitialization(list: XmlNode, baseUrl: string): DashInitialization | undefined {
  const initialization = firstChild(list, "Initialization");
  const sourceUrl = attr(initialization, "sourceURL");
  if (!sourceUrl) {
    return undefined;
  }
  return {
    uri: sourceUrl,
    url: resolveUrl(baseUrl, sourceUrl),
  };
}

function buildDashListSegments(list: XmlNode, baseUrl: string, maxSegments: number): DashSegment[] {
  const timescale = numberAttr(list, "timescale") ?? 1;
  const duration = numberAttr(list, "duration");
  return childNodes(list, "SegmentURL").slice(0, maxSegments).flatMap((segmentUrl, index): DashSegment[] => {
    const media = attr(segmentUrl, "media");
    if (!media) {
      return [];
    }
    return [{
      uri: media,
      url: resolveUrl(baseUrl, media),
      duration: duration && duration > 0 ? duration / timescale : undefined,
      number: index + 1,
    }];
  });
}

export class MediaInspector {
  constructor(
    private readonly cfg: {
      defaultFetchTimeoutMs: number;
      defaultProbeTimeoutMs: number;
      maxProbeTimeoutMs: number;
      maxKeyframes: number;
    } = {
      defaultFetchTimeoutMs: 15_000,
      defaultProbeTimeoutMs: 20_000,
      maxProbeTimeoutMs: 120_000,
      maxKeyframes: 200,
    },
  ) {}

  async inspectHls(params: {
    url: string;
    maxSegments?: number;
    timeoutMs?: number;
  }): Promise<HlsInspectResult> {
    validateStreamUrl(params.url);
    const errors: string[] = [];
    const maxSegments = Math.max(0, Math.min(10_000, Math.floor(params.maxSegments ?? 20)));
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(params.timeoutMs ?? this.cfg.defaultFetchTimeoutMs)));

    const fetched = await fetchText(params.url, timeoutMs);
    const lines = fetched.text.split(/\r?\n/).map((line) => line.trim());

    const variants: HlsVariant[] = [];
    const renditions: HlsRendition[] = [];
    const segments: HlsSegment[] = [];
    let playlistType: HlsInspectResult["playlistType"] = "unknown";
    let targetDuration: number | undefined;
    let mediaSequence: number | undefined;
    let discontinuitySequence: number | undefined;
    let currentMap: HlsMap | undefined;
    const discontinuityMarkers: number[] = [];
    let nextSegmentHasDiscontinuity = false;
    let pendingVariantAttrs: Record<string, string> | null = null;
    let pendingSegment: { duration?: number; title?: string } | null = null;

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!line) continue;
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        playlistType = "master";
        pendingVariantAttrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
        continue;
      }
      if (line.startsWith("#EXT-X-MEDIA:")) {
        playlistType = playlistType === "unknown" ? "master" : playlistType;
        const attrs = parseAttrList(line.slice("#EXT-X-MEDIA:".length));
        const uri = attrs.URI;
        renditions.push({
          type: attrs.TYPE ?? "",
          groupId: attrs["GROUP-ID"],
          name: attrs.NAME,
          language: attrs.LANGUAGE,
          default: parseYesNoAttr(attrs.DEFAULT),
          autoselect: parseYesNoAttr(attrs.AUTOSELECT),
          forced: parseYesNoAttr(attrs.FORCED),
          channels: attrs.CHANNELS,
          characteristics: attrs.CHARACTERISTICS,
          uri,
          url: uri ? resolveUrl(fetched.finalUrl, uri) : undefined,
        });
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        playlistType = playlistType === "unknown" ? "media" : playlistType;
        const payload = line.slice("#EXTINF:".length);
        const [dur, ...titleParts] = payload.split(",");
        const duration = Number.parseFloat(dur);
        pendingSegment = {
          duration: Number.isFinite(duration) ? duration : undefined,
          title: titleParts.join(",").trim() || undefined,
        };
        continue;
      }
      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        const num = Number.parseInt(line.slice("#EXT-X-TARGETDURATION:".length), 10);
        targetDuration = Number.isFinite(num) ? num : undefined;
        continue;
      }
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        const num = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
        mediaSequence = Number.isFinite(num) ? num : undefined;
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        playlistType = playlistType === "unknown" ? "media" : playlistType;
        const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) {
          currentMap = {
            uri: attrs.URI,
            url: resolveUrl(fetched.finalUrl, attrs.URI),
            byteRange: attrs.BYTERANGE,
          };
        }
        continue;
      }
      if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) {
        const num = Number.parseInt(line.slice("#EXT-X-DISCONTINUITY-SEQUENCE:".length), 10);
        discontinuitySequence = Number.isFinite(num) ? num : undefined;
        continue;
      }
      if (line === "#EXT-X-DISCONTINUITY") {
        nextSegmentHasDiscontinuity = true;
        continue;
      }
      if (line.startsWith("#")) continue;

      if (pendingVariantAttrs) {
        variants.push({
          uri: line,
          url: resolveUrl(fetched.finalUrl, line),
          bandwidth: pendingVariantAttrs.BANDWIDTH ? Number.parseInt(pendingVariantAttrs.BANDWIDTH, 10) : undefined,
          averageBandwidth: pendingVariantAttrs["AVERAGE-BANDWIDTH"]
            ? Number.parseInt(pendingVariantAttrs["AVERAGE-BANDWIDTH"], 10)
            : undefined,
          resolution: pendingVariantAttrs.RESOLUTION,
          frameRate: pendingVariantAttrs["FRAME-RATE"]
            ? Number.parseFloat(pendingVariantAttrs["FRAME-RATE"])
            : undefined,
          codecs: pendingVariantAttrs.CODECS,
          audioGroupId: pendingVariantAttrs.AUDIO,
          subtitlesGroupId: pendingVariantAttrs.SUBTITLES,
          closedCaptions: pendingVariantAttrs["CLOSED-CAPTIONS"],
        });
        pendingVariantAttrs = null;
        continue;
      }

      if (segments.length < maxSegments) {
        if (nextSegmentHasDiscontinuity) {
          discontinuityMarkers.push(segments.length);
        }
        segments.push({
          uri: line,
          url: resolveUrl(fetched.finalUrl, line),
          duration: pendingSegment?.duration,
          title: pendingSegment?.title,
          map: currentMap,
        });
      }
      nextSegmentHasDiscontinuity = false;
      pendingSegment = null;
    }

    if (playlistType === "unknown") {
      errors.push("manifest did not contain recognized HLS tags");
    }

    return {
      ok: errors.length === 0,
      url: params.url,
      finalUrl: fetched.finalUrl,
      playlistType,
      variants,
      renditions,
      segments,
      map: segments.find((segment) => segment.map)?.map,
      targetDuration,
      mediaSequence,
      discontinuitySequence,
      discontinuityMarkers,
      errors,
    };
  }

  async inspectDash(params: {
    url: string;
    maxSegments?: number;
    timeoutMs?: number;
  }): Promise<DashInspectResult> {
    validateStreamUrl(params.url);
    const errors: string[] = [];
    const maxSegments = Math.max(0, Math.min(10_000, Math.floor(params.maxSegments ?? 20)));
    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(params.timeoutMs ?? this.cfg.defaultFetchTimeoutMs)));
    const fetched = await fetchText(params.url, timeoutMs);
    const document = parseXml(fetched.text);
    const mpd = document.children.find((child) => localXmlName(child.name) === "MPD");
    if (!mpd) {
      return {
        ok: false,
        url: params.url,
        finalUrl: fetched.finalUrl,
        representations: [],
        errors: ["manifest did not contain MPD root"],
      };
    }

    const mpdBaseUrl = resolveUrl(fetched.finalUrl, firstChildText(mpd, "BaseURL") ?? "");
    const periods = childNodes(mpd, "Period");
    const representations: DashRepresentation[] = [];

    for (const period of periods.length > 0 ? periods : [mpd]) {
      const periodBaseUrl = resolveUrl(mpdBaseUrl, firstChildText(period, "BaseURL") ?? "");
      for (const adaptationSet of childNodes(period, "AdaptationSet")) {
        const adaptationBaseUrl = resolveUrl(periodBaseUrl, firstChildText(adaptationSet, "BaseURL") ?? "");
        const adaptationTemplate = firstChild(adaptationSet, "SegmentTemplate");
        const adaptationList = firstChild(adaptationSet, "SegmentList");
        const adaptationAttrs = adaptationSet.attrs;
        const adaptationContentType = inferDashContentType(adaptationAttrs);

        for (const representationNode of childNodes(adaptationSet, "Representation")) {
          const representationBaseUrl = resolveUrl(adaptationBaseUrl, firstChildText(representationNode, "BaseURL") ?? "");
          const representationAttrs = { ...adaptationAttrs, ...representationNode.attrs };
          const contentType = inferDashContentType(representationAttrs);
          const representation: DashRepresentation = {
            id: attr(representationNode, "id"),
            adaptationSetId: attr(adaptationSet, "id"),
            contentType: contentType === "unknown" ? adaptationContentType : contentType,
            mimeType: attr(representationNode, "mimeType") ?? attr(adaptationSet, "mimeType"),
            codecs: attr(representationNode, "codecs") ?? attr(adaptationSet, "codecs"),
            bandwidth: numberAttr(representationNode, "bandwidth"),
            width: numberAttr(representationNode, "width") ?? numberAttr(adaptationSet, "width"),
            height: numberAttr(representationNode, "height") ?? numberAttr(adaptationSet, "height"),
            frameRate: parseFrameRate(attr(representationNode, "frameRate") ?? attr(adaptationSet, "frameRate")),
            audioSamplingRate:
              numberAttr(representationNode, "audioSamplingRate") ?? numberAttr(adaptationSet, "audioSamplingRate"),
            lang: attr(adaptationSet, "lang"),
            baseUrl: representationBaseUrl,
            segments: [],
          };
          const segmentTemplate = firstChild(representationNode, "SegmentTemplate") ?? adaptationTemplate;
          const segmentList = firstChild(representationNode, "SegmentList") ?? adaptationList;
          if (segmentTemplate) {
            representation.initialization = buildDashTemplateInitialization(segmentTemplate, representation);
            representation.segments = buildDashTemplateSegments(segmentTemplate, representation, maxSegments);
          } else if (segmentList) {
            representation.initialization = buildDashListInitialization(segmentList, representationBaseUrl);
            representation.segments = buildDashListSegments(segmentList, representationBaseUrl, maxSegments);
          } else {
            const directBase = firstChildText(representationNode, "BaseURL");
            if (directBase) {
              representation.segments = [{
                uri: directBase,
                url: representationBaseUrl,
                duration: parseIsoDurationSeconds(attr(mpd, "mediaPresentationDuration")),
              }];
            }
          }
          representations.push(representation);
        }
      }
    }

    if (representations.length === 0) {
      errors.push("MPD did not contain downloadable representations");
    }
    for (const representation of representations) {
      if (representation.segments.length === 0) {
        errors.push(`representation ${representation.id ?? representation.baseUrl} has no supported segments`);
      }
    }

    return {
      ok: errors.length === 0,
      url: params.url,
      finalUrl: fetched.finalUrl,
      type: attr(mpd, "type") === "dynamic" ? "dynamic" : "static",
      profiles: attr(mpd, "profiles"),
      mediaPresentationDurationSeconds: parseIsoDurationSeconds(attr(mpd, "mediaPresentationDuration")),
      minBufferTimeSeconds: parseIsoDurationSeconds(attr(mpd, "minBufferTime")),
      representations,
      errors,
    };
  }

  async probe(params: {
    input: string;
    timeoutMs?: number;
    keyframes?: boolean;
    timeline?: boolean;
    maxKeyframes?: number;
    streamSelector?: string;
  }): Promise<ProbeResult> {
    const timeoutMs = Math.max(
      1_000,
      Math.min(this.cfg.maxProbeTimeoutMs, Math.floor(params.timeoutMs ?? this.cfg.defaultProbeTimeoutMs)),
    );
    const errors: string[] = [];

    const base = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", params.input],
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    if (base.error) {
      throw base.error;
    }
    if (base.status !== 0) {
      return {
        ok: false,
        input: params.input,
        timeoutMs,
        errors: [base.stderr?.trim() || `ffprobe exited with ${String(base.status)}`],
      };
    }

    let parsedBase: { format?: unknown; streams?: unknown[] } = {};
    try {
      parsedBase = JSON.parse(base.stdout || "{}") as { format?: unknown; streams?: unknown[] };
    } catch {
      errors.push("failed to parse ffprobe JSON output");
    }

    let keyframePayload: ProbeResult["keyframes"];
    const streamSelector = (params.streamSelector || "v:0").trim() || "v:0";
    if (params.keyframes) {
      const maxKeyframes = Math.max(1, Math.min(this.cfg.maxKeyframes, Math.floor(params.maxKeyframes ?? 50)));
      const frames = spawnSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          streamSelector,
          "-skip_frame",
          "nokey",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time,pkt_dts_time,pkt_pts_time,key_frame,pict_type",
          "-of",
          "json",
          params.input,
        ],
        {
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (frames.error) {
        throw frames.error;
      }
      if (frames.status !== 0) {
        errors.push(frames.stderr?.trim() || `ffprobe keyframes exited with ${String(frames.status)}`);
      } else {
        try {
          const payload = JSON.parse(frames.stdout || "{}") as { frames?: Array<Record<string, unknown>> };
          const timestamps: number[] = [];
          for (const frame of payload.frames ?? []) {
            const key = frame.key_frame;
            if (!(key === 1 || key === "1")) continue;
            const raw =
              frame.best_effort_timestamp_time ??
              frame.pkt_pts_time ??
              frame.pkt_dts_time;
            const value = typeof raw === "string" || typeof raw === "number"
              ? Number(raw)
              : Number.NaN;
            if (!Number.isFinite(value)) continue;
            timestamps.push(value);
            if (timestamps.length >= maxKeyframes) break;
          }
          keyframePayload = {
            streamSelector,
            count: timestamps.length,
            timestamps,
          };
        } catch {
          errors.push("failed to parse ffprobe keyframes JSON output");
        }
      }
    }

    let timelinePayload: ProbeResult["timeline"];
    if (params.timeline) {
      const useFrames = streamSelector.startsWith("v:");
      const timeline = spawnSync(
        "ffprobe",
        useFrames
          ? [
              "-v",
              "error",
              "-select_streams",
              streamSelector,
              "-show_frames",
              "-show_entries",
              "frame=best_effort_timestamp_time,pkt_dts_time,pkt_pts_time,pkt_duration_time,duration_time,key_frame,pict_type",
              "-of",
              "json",
              params.input,
            ]
          : [
              "-v",
              "error",
              "-select_streams",
              streamSelector,
              "-show_packets",
              "-show_entries",
              "packet=pts_time,dts_time,duration_time,flags",
              "-of",
              "json",
              params.input,
            ],
        {
          encoding: "utf-8",
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (timeline.error) {
        throw timeline.error;
      }
      if (timeline.status !== 0) {
        errors.push(timeline.stderr?.trim() || `ffprobe timeline exited with ${String(timeline.status)}`);
      } else {
        try {
          const payload = JSON.parse(timeline.stdout || "{}") as {
            frames?: Array<Record<string, unknown>>;
            packets?: Array<Record<string, unknown>>;
          };
          const items = useFrames ? (payload.frames ?? []) : (payload.packets ?? []);
          const timestamps = items
            .map((item) => {
              const raw = item.best_effort_timestamp_time ?? item.pts_time ?? item.pkt_pts_time ?? item.dts_time ?? item.pkt_dts_time;
              const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
              return Number.isFinite(value) ? value : null;
            })
            .filter((value): value is number => value !== null);
          const durations = items
            .map((item) => {
              const raw = item.duration_time ?? item.pkt_duration_time;
              const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
              return Number.isFinite(value) ? value : null;
            })
            .filter((value): value is number => value !== null);
          const inferredLastSampleDuration = timestamps.length >= 2
            ? timestamps[timestamps.length - 1] - timestamps[timestamps.length - 2]
            : undefined;
          const keyframeTimestamps = useFrames
            ? (payload.frames ?? [])
              .map((frame) => {
                const key = frame.key_frame;
                if (!(key === 1 || key === "1")) return null;
                const raw = frame.best_effort_timestamp_time ?? frame.pkt_pts_time ?? frame.pkt_dts_time;
                const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
                return Number.isFinite(value) ? value : null;
              })
              .filter((value): value is number => value !== null)
            : [];
          const firstFrame = useFrames ? (payload.frames ?? [])[0] : undefined;
          let maxKeyframeGapSeconds: number | undefined;
          if (keyframeTimestamps.length >= 2) {
            maxKeyframeGapSeconds = 0;
            for (let index = 1; index < keyframeTimestamps.length; index += 1) {
              maxKeyframeGapSeconds = Math.max(
                maxKeyframeGapSeconds,
                keyframeTimestamps[index] - keyframeTimestamps[index - 1],
              );
            }
          }
          timelinePayload = {
            streamSelector,
            sampleKind: useFrames ? "frames" : "packets",
            sampleCount: items.length,
            firstPtsTime: timestamps[0],
            lastPtsTime: timestamps.at(-1),
            lastSampleDurationTime: durations.at(-1) ?? inferredLastSampleDuration,
            keyframeCount: useFrames ? keyframeTimestamps.length : undefined,
            startsWithKeyframe: useFrames
              ? firstFrame?.key_frame === 1 || firstFrame?.key_frame === "1"
              : undefined,
            maxKeyframeGapSeconds,
          };
        } catch {
          errors.push("failed to parse ffprobe timeline JSON output");
        }
      }
    }

    return {
      ok: errors.length === 0,
      input: params.input,
      timeoutMs,
      format: parsedBase.format,
      streams: parsedBase.streams,
      keyframes: keyframePayload,
      timeline: timelinePayload,
      errors,
    };
  }
}
