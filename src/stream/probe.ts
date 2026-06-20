import type { MediaInspector } from "../inspect.js";
import type {
  StreamerClonedRendition,
  StreamerClonedVariant,
  StreamerOriginProbeReport,
  StreamerProbeOptions,
} from "./model.js";
import { normalizeProbeOptions } from "./options.js";
import type { StreamerOriginStore } from "./origin-store.js";

type ProbeService = Pick<MediaInspector, "probe">;

export async function probeOrigin(
  store: StreamerOriginStore,
  inspect: Partial<ProbeService>,
  originId: string,
  options: StreamerProbeOptions = {},
): Promise<StreamerOriginProbeReport> {
  if (!inspect.probe) {
    throw new Error("streamer probe requires ffprobe support in MediaInspector");
  }

  const clone = await store.load(originId);
  const { timeoutMs, maxMediaPlaylists } = normalizeProbeOptions(options);
  const candidates = [
    ...clone.variants.map((variant, index) => ({
      kind: "variant" as const,
      index,
      type: "VIDEO" as const,
      label: formatVariantLabel(variant),
      manifestPath: variant.manifestPath,
    })),
    ...clone.renditions.map((rendition, index) => ({
      kind: "rendition" as const,
      index,
      type: renditionType(rendition),
      label: formatRenditionLabel(rendition),
      manifestPath: rendition.manifestPath,
    })),
  ].slice(0, maxMediaPlaylists);
  const entries: StreamerOriginProbeReport["entries"] = [];

  for (const candidate of candidates) {
    const result = await inspect.probe({
      input: candidate.manifestPath,
      timeoutMs,
    });
    entries.push({
      ...candidate,
      ok: result.ok,
      streamCount: Array.isArray(result.streams) ? result.streams.length : 0,
      errors: result.errors,
    });
  }

  const okCount = entries.filter((entry) => entry.ok).length;
  return {
    originId: clone.id,
    ok: entries.every((entry) => entry.ok),
    sampledMediaPlaylists: entries.length,
    totalMediaPlaylists: clone.variantCount + clone.renditionCount,
    okCount,
    failedCount: entries.length - okCount,
    entries,
  };
}

function renditionType(rendition: StreamerClonedRendition): "AUDIO" | "SUBTITLES" {
  const type = rendition.type.trim().toUpperCase();
  if (type === "AUDIO" || type === "SUBTITLES") {
    return type;
  }
  throw new Error(`unsupported rendition type "${rendition.type}"`);
}

function formatVariantLabel(variant: StreamerClonedVariant): string {
  const source = variant.variant;
  return [
    source?.resolution,
    source?.bandwidth ? `${source.bandwidth}bps` : undefined,
    source?.codecs,
    source?.id,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ") || source?.uri || variant.sourceUri;
}

function formatRenditionLabel(rendition: StreamerClonedRendition): string {
  return [
    rendition.type.toUpperCase(),
    rendition.groupId,
    rendition.name,
    rendition.channels ? `${rendition.channels}ch` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" | ") || rendition.sourceUri;
}
