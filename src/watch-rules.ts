import type { HlsSnapshot, HlsWatchEvent } from "./watch.js";

/**
 * Analisa a transição entre dois snapshots consecutivos de um manifesto HLS e
 * retorna os eventos de qualidade detectados.
 *
 * Esta função é propositalmente **stateless**: não acumula estado entre chamadas.
 * Toda a lógica de detecção se baseia exclusivamente nos dois snapshots passados.
 */
export function analyzeSnapshotTransition(
  prev: HlsSnapshot,
  next: HlsSnapshot,
): HlsWatchEvent[] {
  const events: HlsWatchEvent[] = [];
  const now = new Date().toISOString();

  detectDiscontinuity(prev, next, now, events);
  detectMediaSequenceGap(prev, next, now, events);
  detectStaleManifest(prev, next, now, events);
  detectSegmentDurationAnomalies(next, now, events);
  detectAudioRenditionGap(prev, next, now, events);

  return events;
}

/**
 * Converte um resultado de inspeção HLS num snapshot compacto para análise.
 */
export function toHlsSnapshot(
  inspected: {
    mediaSequence?: number;
    discontinuitySequence?: number;
    discontinuityMarkers: number[];
    targetDuration?: number;
    segments: Array<{ uri: string; duration?: number }>;
    renditions: Array<{ type: string }>;
  },
  fetchedAt: number,
): HlsSnapshot {
  const audioRenditions = inspected.renditions.filter(
    (r) => r.type.toUpperCase() === "AUDIO",
  );
  return {
    fetchedAt,
    mediaSequence: inspected.mediaSequence ?? 0,
    discontinuitySequence: inspected.discontinuitySequence ?? 0,
    targetDuration: inspected.targetDuration ?? 0,
    segments: inspected.segments.map((s) => ({ uri: s.uri, duration: s.duration })),
    discontinuityMarkers: [...inspected.discontinuityMarkers],
    hasAudioRenditions: audioRenditions.length > 0,
    audioRenditionCount: audioRenditions.length,
  };
}

// ─── Detectores individuais ───────────────────────────────────────────────────

/**
 * Detecta inserção de descontinuidade entre dois snapshots.
 *
 * Abordagem:
 * 1. Se EXT-X-DISCONTINUITY-SEQUENCE avançou, houve descontinuidade garantida.
 * 2. Se há marcadores novos que não existiam no snapshot anterior (segmentos
 *    realmente novos com a marca de descontinuidade).
 */
function detectDiscontinuity(
  prev: HlsSnapshot,
  next: HlsSnapshot,
  now: string,
  out: HlsWatchEvent[],
): void {
  const seqJump = next.discontinuitySequence - prev.discontinuitySequence;
  if (seqJump > 0) {
    out.push({
      code: "discontinuity_inserted",
      severity: "warning",
      summary: `EXT-X-DISCONTINUITY-SEQUENCE avançou ${seqJump} unidade(s) desde o último poll.`,
      evidence: [
        `prev_discontinuity_sequence=${prev.discontinuitySequence}`,
        `next_discontinuity_sequence=${next.discontinuitySequence}`,
        `jump=${seqJump}`,
      ],
      detectedAt: now,
    });
    return;
  }

  // Segmentos novos: aqueles além do range do snapshot anterior
  const prevLastSeq = prev.mediaSequence + prev.segments.length;
  const nextOffset = prevLastSeq - next.mediaSequence;
  if (nextOffset < next.segments.length) {
    const newSegmentIndices = next.discontinuityMarkers.filter(
      (idx) => idx >= nextOffset,
    );
    if (newSegmentIndices.length > 0) {
      out.push({
        code: "discontinuity_inserted",
        severity: "warning",
        summary: `${newSegmentIndices.length} marcador(es) #EXT-X-DISCONTINUITY detectado(s) em segmentos novos.`,
        evidence: [
          `new_discontinuity_markers=${newSegmentIndices.length}`,
          `at_segment_indices=${newSegmentIndices.join(",")}`,
          `media_sequence=${next.mediaSequence}`,
        ],
        detectedAt: now,
      });
    }
  }
}

/**
 * Detecta gaps de mediaSequence — quando segmentos foram pulados entre dois polls.
 *
 * Um salto é considerado suspeito quando o avanço de mediaSequence excede o
 * número de segmentos que deveriam ter sido entregues no intervalo entre fetches
 * com uma folga de 50%.
 */
function detectMediaSequenceGap(
  prev: HlsSnapshot,
  next: HlsSnapshot,
  now: string,
  out: HlsWatchEvent[],
): void {
  const seqAdvance = next.mediaSequence - prev.mediaSequence;
  if (seqAdvance <= 0) return; // ainda não avançou (tratado por stale manifest)

  const elapsedMs = next.fetchedAt - prev.fetchedAt;
  const targetDurationMs = (next.targetDuration || prev.targetDuration || 6) * 1_000;
  // Quantos segmentos esperaríamos ter sido consumidos no intervalo
  const expectedSegments = Math.ceil(elapsedMs / targetDurationMs);
  const gapThreshold = Math.max(2, Math.ceil(expectedSegments * 1.5));

  if (seqAdvance > gapThreshold) {
    const missedSegments = seqAdvance - expectedSegments;
    out.push({
      code: "media_sequence_gap",
      severity: seqAdvance > gapThreshold * 2 ? "error" : "warning",
      summary: `MediaSequence avançou ${seqAdvance} em ~${Math.round(elapsedMs / 1000)}s — possível gap de ${missedSegments} segmento(s).`,
      evidence: [
        `prev_media_sequence=${prev.mediaSequence}`,
        `next_media_sequence=${next.mediaSequence}`,
        `advance=${seqAdvance}`,
        `expected_max=${gapThreshold}`,
        `elapsed_ms=${elapsedMs}`,
      ],
      detectedAt: now,
    });
  }
}

/**
 * Detecta manifest congelado: mediaSequence não avançou depois de tempo
 * suficiente para que ao menos um segmento novo devesse ter aparecido.
 */
function detectStaleManifest(
  prev: HlsSnapshot,
  next: HlsSnapshot,
  now: string,
  out: HlsWatchEvent[],
): void {
  if (next.mediaSequence !== prev.mediaSequence) return;

  const elapsedMs = next.fetchedAt - prev.fetchedAt;
  const targetDurationMs = (next.targetDuration || prev.targetDuration || 6) * 1_000;
  // Consideramos stale após 2x o targetDuration sem avanço
  const staleThresholdMs = targetDurationMs * 2;

  if (elapsedMs >= staleThresholdMs) {
    out.push({
      code: "stale_manifest",
      severity: "error",
      summary: `Manifesto não avançou por ${Math.round(elapsedMs / 1000)}s (threshold: ${Math.round(staleThresholdMs / 1000)}s, targetDuration=${next.targetDuration}s).`,
      evidence: [
        `media_sequence=${next.mediaSequence}`,
        `elapsed_ms=${elapsedMs}`,
        `target_duration_ms=${targetDurationMs}`,
        `stale_threshold_ms=${staleThresholdMs}`,
      ],
      detectedAt: now,
    });
  }
}

/**
 * Detecta segmentos com duração muito curta ou muito longa em relação ao
 * targetDuration declarado.
 *
 * Ignora se targetDuration não está definido ou se a duração do segmento não
 * foi informada no manifest.
 */
function detectSegmentDurationAnomalies(
  snapshot: HlsSnapshot,
  now: string,
  out: HlsWatchEvent[],
): void {
  if (!snapshot.targetDuration || snapshot.targetDuration <= 0) return;

  const target = snapshot.targetDuration;
  const shortThreshold = target * 0.3;
  const longThreshold = target * 1.5;

  const shortSegments: string[] = [];
  const longSegments: string[] = [];

  for (const seg of snapshot.segments) {
    if (typeof seg.duration !== "number" || !Number.isFinite(seg.duration)) continue;
    if (seg.duration < shortThreshold) {
      shortSegments.push(`${seg.uri} (${seg.duration.toFixed(2)}s)`);
    } else if (seg.duration > longThreshold) {
      longSegments.push(`${seg.uri} (${seg.duration.toFixed(2)}s)`);
    }
  }

  if (shortSegments.length > 0) {
    out.push({
      code: "segment_duration_anomaly",
      severity: shortSegments.length >= 2 ? "error" : "warning",
      summary: `${shortSegments.length} segmento(s) com duração muito curta (< ${shortThreshold.toFixed(1)}s, targetDuration=${target}s).`,
      evidence: [
        `target_duration=${target}s`,
        `short_threshold=${shortThreshold.toFixed(1)}s`,
        ...shortSegments.slice(0, 3),
      ],
      detectedAt: now,
    });
  }

  if (longSegments.length > 0) {
    out.push({
      code: "segment_duration_anomaly",
      severity: "warning",
      summary: `${longSegments.length} segmento(s) com duração excessiva (> ${longThreshold.toFixed(1)}s, targetDuration=${target}s).`,
      evidence: [
        `target_duration=${target}s`,
        `long_threshold=${longThreshold.toFixed(1)}s`,
        ...longSegments.slice(0, 3),
      ],
      detectedAt: now,
    });
  }
}

/**
 * Detecta gaps de rendição de áudio entre snapshots.
 *
 * Se o snapshot anterior tinha rendições de áudio e o próximo não tem mais,
 * ou se o número caiu significativamente, é um sinal de problema na manifest.
 */
function detectAudioRenditionGap(
  prev: HlsSnapshot,
  next: HlsSnapshot,
  now: string,
  out: HlsWatchEvent[],
): void {
  if (!prev.hasAudioRenditions) return;

  if (!next.hasAudioRenditions) {
    out.push({
      code: "audio_rendition_gap",
      severity: "error",
      summary: "Rendições de áudio desapareceram do manifest (EXT-X-MEDIA TYPE=AUDIO não declarado).",
      evidence: [
        `prev_audio_renditions=${prev.audioRenditionCount}`,
        `next_audio_renditions=${next.audioRenditionCount}`,
      ],
      detectedAt: now,
    });
    return;
  }

  if (next.audioRenditionCount < prev.audioRenditionCount) {
    const lost = prev.audioRenditionCount - next.audioRenditionCount;
    out.push({
      code: "audio_rendition_gap",
      severity: "warning",
      summary: `${lost} rendição(ões) de áudio removida(s) do manifest.`,
      evidence: [
        `prev_audio_renditions=${prev.audioRenditionCount}`,
        `next_audio_renditions=${next.audioRenditionCount}`,
        `lost=${lost}`,
      ],
      detectedAt: now,
    });
  }
}
