import type { ManifestSeverity } from "../manifest.js";
import type {
  StreamerCloneResult,
  StreamerClonedVariant,
} from "./model.js";

type HlsVariantLike = {
  codecs?: string;
  audioGroupId?: string;
};

export type StreamerBrowserCompatibility = "yes" | "partial" | "no" | "unknown";

export type StreamerVariantDiagnostic = {
  index: number;
  label: string;
  browserStatus: "compatible" | "incompatible" | "unknown";
  reason: string;
  codecs: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  audioGroupId?: string;
};

export type StreamerDiagnosticIssue = {
  code: string;
  severity: ManifestSeverity;
  summary: string;
  evidence: string[];
};

export type StreamerCloneDiagnostic = {
  browserCompatibility: StreamerBrowserCompatibility;
  browserCompatibleVariantCount: number;
  variantCount: number;
  externalAudio: boolean;
  externalSubtitles: boolean;
  audioRenditionCount: number;
  subtitleRenditionCount: number;
  videoCodecs: string[];
  audioCodecs: string[];
  variants: StreamerVariantDiagnostic[];
  issues: StreamerDiagnosticIssue[];
  recommendations: string[];
};

export function isBrowserSafeHlsVariant(variant: HlsVariantLike): boolean {
  return inspectHlsVariantBrowserCompatibility(variant).browserStatus === "compatible";
}

export function inspectHlsVariantBrowserCompatibility(
  variant: HlsVariantLike,
): Omit<StreamerVariantDiagnostic, "index" | "label"> {
  const codecs = splitCodecs(variant.codecs);
  const videoCodecs = codecs.filter(isVideoCodec);
  const audioCodecs = codecs.filter(isAudioCodec);
  const audioGroupId = variant.audioGroupId;
  const normalizedAudioGroup = audioGroupId?.toLowerCase() ?? "";
  const unsupportedAudio = audioCodecs.filter(isKnownBrowserRiskAudioCodec);
  const hasAacAudio = audioCodecs.some(isAacCodec) || normalizedAudioGroup.includes("aac");

  if (unsupportedAudio.length > 0 || normalizedAudioGroup.includes("ec-3") || normalizedAudioGroup.includes("ac-3")) {
    return {
      browserStatus: "incompatible",
      reason: `audio codec de risco para browser: ${unsupportedAudio.join(",") || audioGroupId}`,
      codecs,
      videoCodecs,
      audioCodecs,
      ...(audioGroupId ? { audioGroupId } : {}),
    };
  }

  if (hasAacAudio) {
    return {
      browserStatus: "compatible",
      reason: "audio AAC/mp4a",
      codecs,
      videoCodecs,
      audioCodecs,
      ...(audioGroupId ? { audioGroupId } : {}),
    };
  }

  return {
    browserStatus: "unknown",
    reason: "sem codec de audio AAC/mp4a declarado",
    codecs,
    videoCodecs,
    audioCodecs,
    ...(audioGroupId ? { audioGroupId } : {}),
  };
}

export function diagnoseStreamerClone(origin: StreamerCloneResult): StreamerCloneDiagnostic {
  const variants = origin.variants.map((variant, index) => {
    const compatibility = inspectHlsVariantBrowserCompatibility(variant.variant ?? {});
    return {
      index,
      label: formatDiagnosticVariantLabel(variant),
      ...compatibility,
    };
  });
  const compatibleCount = variants.filter((variant) => variant.browserStatus === "compatible").length;
  const unknownCount = variants.filter((variant) => variant.browserStatus === "unknown").length;
  const browserCompatibility = deriveBrowserCompatibility(origin.variantCount, compatibleCount, unknownCount);
  const videoCodecs = uniqueStrings(variants.flatMap((variant) => variant.videoCodecs));
  const audioCodecs = uniqueStrings(variants.flatMap((variant) => variant.audioCodecs));
  const audioRenditionCount = origin.renditions.filter((rendition) => rendition.type.toUpperCase() === "AUDIO").length;
  const subtitleRenditionCount = origin.renditions.filter(
    (rendition) => rendition.type.toUpperCase() === "SUBTITLES",
  ).length;
  const issues = buildDiagnosticIssues(variants, browserCompatibility);
  const recommendations = buildDiagnosticRecommendations(browserCompatibility, origin.allVariants);

  return {
    browserCompatibility,
    browserCompatibleVariantCount: compatibleCount,
    variantCount: origin.variantCount,
    externalAudio: audioRenditionCount > 0,
    externalSubtitles: subtitleRenditionCount > 0,
    audioRenditionCount,
    subtitleRenditionCount,
    videoCodecs,
    audioCodecs,
    variants,
    issues,
    recommendations,
  };
}

function deriveBrowserCompatibility(
  variantCount: number,
  compatibleCount: number,
  unknownCount: number,
): StreamerBrowserCompatibility {
  if (variantCount === 0) {
    return "unknown";
  }
  if (compatibleCount === variantCount) {
    return "yes";
  }
  if (compatibleCount > 0) {
    return "partial";
  }
  if (unknownCount === variantCount) {
    return "unknown";
  }
  return "no";
}

function buildDiagnosticIssues(
  variants: StreamerVariantDiagnostic[],
  browserCompatibility: StreamerBrowserCompatibility,
): StreamerDiagnosticIssue[] {
  const issues: StreamerDiagnosticIssue[] = [];

  if (browserCompatibility === "no") {
    issues.push({
      code: "no_browser_safe_variant",
      severity: "error",
      summary: "Nenhuma variant clonada parece segura para browser comum.",
      evidence: variants.map((variant) => `[${variant.index}] ${variant.reason}`),
    });
  }

  for (const variant of variants) {
    if (variant.browserStatus === "incompatible") {
      issues.push({
        code: "browser_risky_audio_codec",
        severity: "warning",
        summary: `Variant ${variant.index} usa audio pouco compativel com browser.`,
        evidence: [
          `variant=${variant.label}`,
          `audioCodecs=${variant.audioCodecs.join(",") || "unknown"}`,
          `audioGroup=${variant.audioGroupId ?? "none"}`,
        ],
      });
    }
    if (variant.browserStatus === "unknown") {
      issues.push({
        code: "unknown_audio_codec",
        severity: "warning",
        summary: `Variant ${variant.index} nao declara audio AAC/mp4a de forma verificavel.`,
        evidence: [
          `variant=${variant.label}`,
          `codecs=${variant.codecs.join(",") || "none"}`,
          `audioGroup=${variant.audioGroupId ?? "none"}`,
        ],
      });
    }
  }

  return issues;
}

function buildDiagnosticRecommendations(
  browserCompatibility: StreamerBrowserCompatibility,
  allVariants: boolean,
): string[] {
  if (browserCompatibility === "yes") {
    return [];
  }

  if (browserCompatibility === "partial" && allVariants) {
    return ["No player web, force uma rendition/variant AAC se o ABR escolher EC-3/AC-3."];
  }

  return ["Reclone usando --variant aac-highest ou um indice de variant AAC/mp4a."];
}

function splitCodecs(codecs: string | undefined): string[] {
  if (!codecs?.trim()) {
    return [];
  }
  return codecs
    .split(",")
    .map((codec) => codec.trim())
    .filter(Boolean);
}

function isVideoCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return (
    normalized.startsWith("avc1") ||
    normalized.startsWith("avc3") ||
    normalized.startsWith("hvc1") ||
    normalized.startsWith("hev1") ||
    normalized.startsWith("dvh1") ||
    normalized.startsWith("dvhe") ||
    normalized.startsWith("vp09") ||
    normalized.startsWith("av01")
  );
}

function isAudioCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return (
    normalized.startsWith("mp4a") ||
    normalized === "aac" ||
    normalized.startsWith("ec-3") ||
    normalized.startsWith("ac-3") ||
    normalized === "ec3" ||
    normalized === "ac3" ||
    normalized.startsWith("opus") ||
    normalized.startsWith("vorbis") ||
    normalized.startsWith("flac")
  );
}

function isAacCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return normalized.startsWith("mp4a") || normalized === "aac";
}

function isKnownBrowserRiskAudioCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return normalized.startsWith("ec-3") || normalized.startsWith("ac-3") || normalized === "ec3" || normalized === "ac3";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatDiagnosticVariantLabel(variant: StreamerClonedVariant): string {
  const parts = [
    variant.variant?.resolution,
    typeof variant.variant?.bandwidth === "number" ? `${variant.variant.bandwidth}bps` : undefined,
    variant.variant?.codecs,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" | ") : variant.sourceUri;
}
