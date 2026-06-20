import type { HlsInspectResult, MediaInspector } from "./inspect.js";

export type ManifestSeverity = "info" | "warning" | "error";
export type ManifestAuditIssue = { code: string; severity: ManifestSeverity; summary: string; evidence: string[] };
export type ManifestAuditInput = {
  url: string;
  maxSegments?: number;
  timeoutMs?: number;
  followVariants?: boolean;
  maxVariants?: number;
};
export type ManifestVariantAudit = {
  uri: string;
  url: string;
  finalUrl: string;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: string;
  frameRate?: number;
  codecs?: string;
  audioGroupId?: string;
  subtitlesGroupId?: string;
  playlistType: "master" | "media" | "unknown";
  summary: string;
  ok: boolean;
  stats: { segments: number; targetDuration?: number; maxSegmentDuration?: number; minSegmentDuration?: number; averageSegmentDuration?: number };
  issues: ManifestAuditIssue[];
};
export type ManifestAuditReport = {
  ok: boolean;
  url: string;
  finalUrl: string;
  playlistType: "master" | "media" | "unknown";
  summary: string;
  stats: { variants: number; renditions: number; segments: number; variantsAudited: number; variantsWithErrors: number; targetDuration?: number; maxSegmentDuration?: number; minSegmentDuration?: number; averageSegmentDuration?: number };
  issues: ManifestAuditIssue[];
  variantAudits: ManifestVariantAudit[];
  aggregateIssues: ManifestAuditIssue[];
  recommendations: string[];
};

type HlsInspectLike = Pick<MediaInspector, "inspectHls">;

type RootAuditContext = {
  variantAudits: ManifestVariantAudit[];
  aggregateIssues: ManifestAuditIssue[];
};

export class ManifestAudit {
  constructor(private readonly inspect: HlsInspectLike) {}

  async audit(input: ManifestAuditInput): Promise<ManifestAuditReport> {
    const inspected = await this.inspect.inspectHls({
      url: input.url,
      maxSegments: input.maxSegments,
      timeoutMs: input.timeoutMs,
    });

    const rootContext =
      input.followVariants && inspected.playlistType === "master"
        ? await this.auditVariants(inspected, input)
        : { variantAudits: [], aggregateIssues: [] };

    return buildRootReport(inspected, rootContext);
  }

  private async auditVariants(
    inspected: HlsInspectResult,
    input: ManifestAuditInput,
  ): Promise<RootAuditContext> {
    const maxVariants = Math.max(1, Math.min(12, Math.floor(input.maxVariants ?? inspected.variants.length)));
    const selectedVariants = inspected.variants.slice(0, maxVariants);
    const variantAudits: ManifestVariantAudit[] = [];
    for (const variant of selectedVariants) {
      try {
        const variantInspected = await this.inspect.inspectHls({
          url: variant.url,
          maxSegments: input.maxSegments,
          timeoutMs: input.timeoutMs,
        });
        variantAudits.push(buildVariantReport(variant, variantInspected));
      } catch (error) {
        variantAudits.push(buildVariantFetchFailure(variant, error));
      }
    }

    return {
      variantAudits,
      aggregateIssues: buildAggregateIssues(inspected, variantAudits),
    };
  }
}

function buildRootReport(
  inspected: HlsInspectResult,
  context: RootAuditContext = { variantAudits: [], aggregateIssues: [] },
): ManifestAuditReport {
  const rootIssues = buildIssues(inspected);
  const allIssues = [...rootIssues, ...context.aggregateIssues, ...context.variantAudits.flatMap((variant) => variant.issues)];
  const segmentDurations = collectSegmentDurations(inspected);
  const recommendations = buildRecommendations(inspected, rootIssues, context);

  return {
    ok: !allIssues.some((issue) => issue.severity === "error"),
    url: inspected.url,
    finalUrl: inspected.finalUrl,
    playlistType: inspected.playlistType,
    summary: buildSummary(inspected, rootIssues, context),
    stats: {
      variants: inspected.variants.length,
      renditions: inspected.renditions.length,
      segments: inspected.segments.length,
      variantsAudited: context.variantAudits.length,
      variantsWithErrors: context.variantAudits.filter((variant) =>
        variant.issues.some((issue) => issue.severity === "error"),
      ).length,
      targetDuration: inspected.targetDuration,
      maxSegmentDuration: segmentDurations.length > 0 ? Math.max(...segmentDurations) : undefined,
      minSegmentDuration: segmentDurations.length > 0 ? Math.min(...segmentDurations) : undefined,
      averageSegmentDuration:
        segmentDurations.length > 0 ? segmentDurations.reduce((acc, duration) => acc + duration, 0) / segmentDurations.length : undefined,
    },
    issues: rootIssues,
    variantAudits: context.variantAudits,
    aggregateIssues: context.aggregateIssues,
    recommendations,
  };
}

function buildVariantReport(
  variant: HlsInspectResult["variants"][number],
  inspected: HlsInspectResult,
): ManifestVariantAudit {
  const issues = buildIssues(inspected);
  const segmentDurations = collectSegmentDurations(inspected);

  if (inspected.playlistType !== "media") {
    issues.push({
      code: "variant_not_media_playlist",
      severity: "error",
      summary: "A variant auditada nao resolveu para uma media playlist valida.",
      evidence: [variant.url, `playlistType=${inspected.playlistType}`],
    });
  }

  return {
    uri: variant.uri,
    url: variant.url,
    finalUrl: inspected.finalUrl,
    bandwidth: variant.bandwidth,
    averageBandwidth: variant.averageBandwidth,
    resolution: variant.resolution,
    frameRate: variant.frameRate,
    codecs: variant.codecs,
    audioGroupId: variant.audioGroupId,
    subtitlesGroupId: variant.subtitlesGroupId,
    playlistType: inspected.playlistType,
    summary: buildVariantSummary(variant, inspected, issues),
    ok: !issues.some((issue) => issue.severity === "error"),
    stats: {
      segments: inspected.segments.length,
      targetDuration: inspected.targetDuration,
      maxSegmentDuration: segmentDurations.length > 0 ? Math.max(...segmentDurations) : undefined,
      minSegmentDuration: segmentDurations.length > 0 ? Math.min(...segmentDurations) : undefined,
      averageSegmentDuration:
        segmentDurations.length > 0 ? segmentDurations.reduce((acc, duration) => acc + duration, 0) / segmentDurations.length : undefined,
    },
    issues,
  };
}

function buildVariantFetchFailure(
  variant: HlsInspectResult["variants"][number],
  error: unknown,
): ManifestVariantAudit {
  const message = error instanceof Error ? error.message : String(error);
  return {
    uri: variant.uri,
    url: variant.url,
    finalUrl: variant.url,
    bandwidth: variant.bandwidth,
    averageBandwidth: variant.averageBandwidth,
    resolution: variant.resolution,
    frameRate: variant.frameRate,
    codecs: variant.codecs,
    audioGroupId: variant.audioGroupId,
    subtitlesGroupId: variant.subtitlesGroupId,
    playlistType: "unknown",
    summary: "A variant nao pode ser buscada ou interpretada.",
    ok: false,
    stats: { segments: 0 },
    issues: [{
      code: "inspect_error",
      severity: "error",
      summary: "Falha ao buscar ou interpretar a media playlist da variant.",
      evidence: [`url=${variant.url}`, `error=${message}`],
    }],
  };
}

function buildAggregateIssues(
  root: HlsInspectResult,
  variantAudits: ManifestVariantAudit[],
): ManifestAuditIssue[] {
  const issues: ManifestAuditIssue[] = [];
  if (variantAudits.length === 0) {
    return issues;
  }

  const successfulVariants = variantAudits.filter((variant) => variant.playlistType === "media" && variant.issues.every((issue) => issue.severity !== "error"));
  if (root.variants.length > 1 && successfulVariants.length <= 1) {
    issues.push({
      code: "single_working_variant",
      severity: "error",
      summary: "A ladder auditada tem no maximo uma variant realmente saudavel entre as variants verificadas.",
      evidence: [`variantsAudited=${variantAudits.length}`, `workingVariants=${successfulVariants.length}`],
    });
  }

  const failedFetches = variantAudits.filter((variant) => variant.issues.some((issue) => issue.code === "inspect_error"));
  if (failedFetches.length > 0) {
    issues.push({
      code: "variant_fetch_failures",
      severity: "error",
      summary: `${failedFetches.length} variant(s) falharam durante fetch/parse da media playlist.`,
      evidence: failedFetches.slice(0, 3).map((variant) => variant.url),
    });
  }

  const targetDurations = variantAudits
    .map((variant) => variant.stats.targetDuration)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (targetDurations.length >= 2) {
    const minTarget = Math.min(...targetDurations);
    const maxTarget = Math.max(...targetDurations);
    if (maxTarget - minTarget > 2) {
      issues.push({
        code: "inconsistent_target_duration",
        severity: "warning",
        summary: "As variants auditadas usam TARGETDURATION inconsistente entre si.",
        evidence: [`min=${minTarget}s`, `max=${maxTarget}s`],
      });
    }
  }

  const duplicateResolutions = collectDuplicateResolutions(root);
  if (duplicateResolutions.length > 0) {
    issues.push({
      code: "duplicate_resolution_variants",
      severity: "warning",
      summary: "A master playlist declara multiplas variants com a mesma resolucao, o que pode confundir a ladder ABR.",
      evidence: duplicateResolutions.slice(0, 3),
    });
  }

  const codecFamilies = new Set(
    root.variants
      .map((variant) => normalizeCodecFamily(variant.codecs))
      .filter((value): value is string => Boolean(value)),
  );
  if (codecFamilies.size > 1) {
    issues.push({
      code: "codec_family_inconsistency",
      severity: "warning",
      summary: "A ladder mistura familias de codec diferentes entre variants auditadas.",
      evidence: [...codecFamilies].slice(0, 4),
    });
  }

  return issues;
}

function buildIssues(inspected: HlsInspectResult): ManifestAuditIssue[] {
  const issues: ManifestAuditIssue[] = [];

  for (const error of inspected.errors) {
    issues.push({
      code: "inspect_error",
      severity: "error",
      summary: `Falha estrutural detectada na leitura do manifesto: ${error}.`,
      evidence: [error],
    });
  }

  if (inspected.playlistType === "unknown") {
    issues.push({
      code: "unknown_playlist_type",
      severity: "error",
      summary: "O manifesto nao foi reconhecido como HLS master nem media playlist.",
      evidence: [inspected.finalUrl],
    });
    return dedupeIssues(issues);
  }

  if (inspected.playlistType === "master") {
    issues.push(...buildMasterIssues(inspected));
  }

  if (inspected.playlistType === "media") {
    issues.push(...buildMediaIssues(inspected));
  }

  return dedupeIssues(issues);
}

function buildMasterIssues(inspected: HlsInspectResult): ManifestAuditIssue[] {
  const issues: ManifestAuditIssue[] = [];

  if (inspected.variants.length === 0) {
    issues.push({
      code: "master_without_variants",
      severity: "error",
      summary: "A master playlist nao declara nenhuma variant stream.",
      evidence: [inspected.finalUrl],
    });
    return issues;
  }

  if (inspected.variants.length === 1) {
    issues.push({
      code: "single_variant_ladder",
      severity: "warning",
      summary: "A master playlist expoe apenas uma variant, reduzindo resiliencia de ABR.",
      evidence: [formatVariantEvidence(inspected.variants[0])],
    });
  }

  const variantsWithoutBandwidth = inspected.variants.filter((variant) => !variant.bandwidth);
  if (variantsWithoutBandwidth.length > 0) {
    issues.push({
      code: "variant_missing_bandwidth",
      severity: "warning",
      summary: `${variantsWithoutBandwidth.length} variant(s) nao declaram BANDWIDTH.`,
      evidence: variantsWithoutBandwidth.slice(0, 3).map((variant) => variant.uri),
    });
  }

  const variantsWithoutCodecs = inspected.variants.filter((variant) => !variant.codecs?.trim());
  if (variantsWithoutCodecs.length > 0) {
    issues.push({
      code: "variant_missing_codecs",
      severity: "warning",
      summary: `${variantsWithoutCodecs.length} variant(s) nao declaram CODECS, o que dificulta compatibilidade e troubleshooting.`,
      evidence: variantsWithoutCodecs.slice(0, 3).map((variant) => variant.uri),
    });
  }

  const audioGroups = new Set(inspected.renditions.filter((rendition) => rendition.type === "AUDIO").map((r) => r.groupId));
  const variantsWithMissingAudioGroup = inspected.variants.filter(
    (variant) => variant.audioGroupId && !audioGroups.has(variant.audioGroupId),
  );
  if (variantsWithMissingAudioGroup.length > 0) {
    issues.push({
      code: "missing_audio_group_rendition",
      severity: "error",
      summary: "Uma ou mais variants referenciam grupo de audio inexistente em EXT-X-MEDIA.",
      evidence: variantsWithMissingAudioGroup.slice(0, 3).map((variant) => formatVariantEvidence(variant)),
    });
  }

  return issues;
}

function buildMediaIssues(inspected: HlsInspectResult): ManifestAuditIssue[] {
  const issues: ManifestAuditIssue[] = [];
  const segmentDurations = collectSegmentDurations(inspected);

  if (inspected.segments.length === 0) {
    issues.push({
      code: "media_without_segments",
      severity: "error",
      summary: "A media playlist nao expoe nenhum segmento util nos primeiros itens lidos.",
      evidence: [inspected.finalUrl],
    });
    return issues;
  }

  if (typeof inspected.targetDuration !== "number") {
    issues.push({
      code: "missing_target_duration",
      severity: "error",
      summary: "A media playlist nao declara EXT-X-TARGETDURATION.",
      evidence: [inspected.finalUrl],
    });
  }

  if (typeof inspected.targetDuration === "number" && inspected.targetDuration > 12) {
    issues.push({
      code: "high_target_duration",
      severity: "warning",
      summary: `A playlist usa TARGETDURATION=${inspected.targetDuration}, sugerindo segmentos longos para playback adaptativo.`,
      evidence: [`targetDuration=${inspected.targetDuration}`],
    });
  }

  if (segmentDurations.length === 0) {
    issues.push({
      code: "segments_missing_extinf",
      severity: "warning",
      summary: "Os segmentos auditados nao possuem duracao parsavel via EXTINF.",
      evidence: inspected.segments.slice(0, 3).map((segment) => segment.uri),
    });
    return issues;
  }

  if (typeof inspected.targetDuration === "number") {
    const targetDuration = inspected.targetDuration;
    const oversized = inspected.segments.filter(
      (segment) => typeof segment.duration === "number" && segment.duration > targetDuration + 0.5,
    );
    if (oversized.length > 0) {
      issues.push({
        code: "segment_exceeds_target_duration",
        severity: "error",
        summary: `${oversized.length} segmento(s) excedem TARGETDURATION de forma relevante.`,
        evidence: oversized.slice(0, 3).map((segment) => formatSegmentEvidence(segment)),
      });
    }
  }

  const maxDuration = Math.max(...segmentDurations);
  const minDuration = Math.min(...segmentDurations);
  if (maxDuration - minDuration > 3) {
    issues.push({
      code: "segment_duration_variation",
      severity: "warning",
      summary: "Os primeiros segmentos apresentam variacao alta de duracao, o que pode afetar latencia e estabilidade de ABR.",
      evidence: [`min=${minDuration.toFixed(3)}s`, `max=${maxDuration.toFixed(3)}s`],
    });
  }

  return issues;
}

function buildSummary(
  inspected: HlsInspectResult,
  rootIssues: ManifestAuditIssue[],
  context: RootAuditContext,
): string {
  const severity = highestSeverity([...rootIssues, ...context.aggregateIssues, ...context.variantAudits.flatMap((variant) => variant.issues)]);
  if (inspected.playlistType === "master") {
    const expansionSuffix =
      context.variantAudits.length > 0
        ? ` variantsAudited=${context.variantAudits.length}, aggregateIssues=${context.aggregateIssues.length}.`
        : "";
    return `Auditoria de manifesto HLS master concluida com status ${severity}. variants=${inspected.variants.length}, renditions=${inspected.renditions.length}.${expansionSuffix}`;
  }
  if (inspected.playlistType === "media") {
    return `Auditoria de manifesto HLS media concluida com status ${severity}. segments=${inspected.segments.length}, targetDuration=${inspected.targetDuration ?? "n/a"}.`;
  }
  return `Auditoria de manifesto HLS concluida com status ${severity}.`;
}

function buildVariantSummary(
  variant: HlsInspectResult["variants"][number],
  inspected: HlsInspectResult,
  issues: ManifestAuditIssue[],
): string {
  const severity = highestSeverity(issues);
  return `Variant ${variant.uri} auditada com status ${severity}. playlistType=${inspected.playlistType}, segments=${inspected.segments.length}, targetDuration=${inspected.targetDuration ?? "n/a"}.`;
}

function buildRecommendations(
  inspected: HlsInspectResult,
  rootIssues: ManifestAuditIssue[],
  context: RootAuditContext,
): string[] {
  const recommendations = new Set<string>();
  const allIssues = [...rootIssues, ...context.aggregateIssues, ...context.variantAudits.flatMap((variant) => variant.issues)];

  if (allIssues.some((issue) => issue.code === "master_without_variants" || issue.code === "single_variant_ladder")) {
    recommendations.add("Revisar a ladder ABR e garantir mais de uma variant para degradacao controlada de bitrate.");
  }
  if (allIssues.some((issue) => issue.code === "variant_missing_bandwidth" || issue.code === "variant_missing_codecs")) {
    recommendations.add("Normalizar tags de variant (BANDWIDTH, CODECS, RESOLUTION) no packager para melhorar compatibilidade e observabilidade.");
  }
  if (allIssues.some((issue) => issue.code === "missing_audio_group_rendition")) {
    recommendations.add("Corrigir o mapeamento entre EXT-X-STREAM-INF:AUDIO e EXT-X-MEDIA para evitar falhas de selecao de trilha.");
  }
  if (allIssues.some((issue) => issue.code === "missing_target_duration" || issue.code === "segment_exceeds_target_duration")) {
    recommendations.add("Validar segmentacao no encoder/packager e alinhar EXTINF/TARGETDURATION com a duracao real dos segmentos.");
  }
  if (allIssues.some((issue) => issue.code === "high_target_duration" || issue.code === "segment_duration_variation")) {
    recommendations.add("Revisar tamanho dos segmentos e consistencia do GOP para reduzir latencia e oscilacao de playback.");
  }
  if (allIssues.some((issue) => issue.code === "inconsistent_target_duration")) {
    recommendations.add("Garantir que todas as variants usem segmentacao e TARGETDURATION alinhados para evitar drift na ladder.");
  }
  if (allIssues.some((issue) => issue.code === "variant_fetch_failures" || issue.code === "single_working_variant")) {
    recommendations.add("Auditar a disponibilidade real de todas as variants criticas e bloquear release se a ladder nao sustentar fallback de ABR.");
  }
  if (allIssues.some((issue) => issue.code === "duplicate_resolution_variants" || issue.code === "codec_family_inconsistency")) {
    recommendations.add("Revisar a consistencia global da ladder para evitar niveis redundantes ou incompatibilidades por codec.");
  }
  if (allIssues.some((issue) => issue.severity === "error")) {
    recommendations.add("Cruzar este manifesto com `video_probe` e com a sessao de playback afetada antes de liberar para producao.");
  }
  if (recommendations.size === 0) {
    recommendations.add("Manifesto sem sinais fortes de erro estrutural nos checks atuais; seguir com validacao em player/device real.");
  }
  if (inspected.playlistType === "master" && context.variantAudits.length === 0) {
    recommendations.add("Auditar ao menos uma media playlist derivada de cada variant critica para validar segmentos reais.");
  }

  return [...recommendations];
}

function highestSeverity(issues: ManifestAuditIssue[]): ManifestSeverity {
  if (issues.some((issue) => issue.severity === "error")) return "error";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "info";
}

function collectSegmentDurations(inspected: HlsInspectResult): number[] {
  return inspected.segments
    .map((segment) => segment.duration)
    .filter((duration): duration is number => typeof duration === "number" && Number.isFinite(duration));
}

function dedupeIssues(issues: ManifestAuditIssue[]): ManifestAuditIssue[] {
  const seen = new Set<string>();
  const out: ManifestAuditIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.summary}|${issue.evidence.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function collectDuplicateResolutions(inspected: HlsInspectResult): string[] {
  const counts = new Map<string, number>();
  for (const variant of inspected.variants) {
    if (!variant.resolution) continue;
    counts.set(variant.resolution, (counts.get(variant.resolution) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([resolution, count]) => `${resolution} x${count}`);
}

function normalizeCodecFamily(codecs: string | undefined): string | undefined {
  if (!codecs?.trim()) {
    return undefined;
  }
  const normalized = codecs.toLowerCase();
  if (normalized.includes("avc1")) return "avc";
  if (normalized.includes("hvc1") || normalized.includes("hev1")) return "hevc";
  if (normalized.includes("av01")) return "av1";
  if (normalized.includes("vp9")) return "vp9";
  return codecs.split(",")[0]?.trim().toLowerCase() || undefined;
}

function formatVariantEvidence(variant: HlsInspectResult["variants"][number]): string {
  return `${variant.uri} bandwidth=${variant.bandwidth ?? "n/a"} codecs=${variant.codecs ?? "n/a"} resolution=${variant.resolution ?? "n/a"}`;
}

function formatSegmentEvidence(segment: HlsInspectResult["segments"][number]): string {
  return `${segment.uri} duration=${segment.duration ?? "n/a"}s`;
}
