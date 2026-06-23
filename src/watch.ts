import { randomUUID } from "node:crypto";
import type { MediaInspector } from "./inspect.js";
import type { ManifestSeverity } from "./manifest.js";
import { analyzeSnapshotTransition, toHlsSnapshot } from "./watch-rules.js";

export type HlsSnapshot = {
  fetchedAt: number;
  mediaSequence: number;
  discontinuitySequence: number;
  targetDuration: number;
  segments: Array<{ uri: string; duration?: number }>;
  discontinuityMarkers: number[];
  hasAudioRenditions: boolean;
  audioRenditionCount: number;
};

export type HlsWatchEvent = {
  code: string;
  severity: ManifestSeverity;
  summary: string;
  evidence: string[];
  detectedAt: string;
};

export type HlsWatchInput = {
  url: string;
  pollIntervalMs?: number;
  maxPollCount?: number;
  timeoutMs?: number;
  maxEvents?: number;
};

export type HlsWatchStatus = {
  id: string;
  url: string;
  startedAt: string;
  lastPollAt: string | null;
  pollCount: number;
  errorCount: number;
  events: HlsWatchEvent[];
  running: boolean;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_EVENTS = 500;

type WatchSession = {
  id: string;
  url: string;
  pollIntervalMs: number;
  timeoutMs: number;
  maxPollCount: number | undefined;
  maxEvents: number;
  startedAt: string;
  lastPollAt: string | null;
  pollCount: number;
  errorCount: number;
  events: HlsWatchEvent[];
  running: boolean;
  lastSnapshot: HlsSnapshot | null;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Serviço de monitoramento contínuo de streams HLS.
 *
 * Cada sessão de watch faz polling periódico do manifesto e compara
 * snapshots consecutivos com o HlsSnapshotAnalyzer para detectar anomalias
 * de qualidade em tempo real.
 */
export class HlsWatchService {
  private readonly sessions = new Map<string, WatchSession>();

  constructor(private readonly inspect: Pick<MediaInspector, "inspectHls">) {}

  /**
   * Inicia uma nova sessão de monitoramento e retorna o ID da sessão.
   */
  startWatch(params: HlsWatchInput): string {
    const id = randomUUID();
    const pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );

    const session: WatchSession = {
      id,
      url: params.url,
      pollIntervalMs,
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxPollCount: params.maxPollCount,
      maxEvents: params.maxEvents ?? DEFAULT_MAX_EVENTS,
      startedAt: new Date().toISOString(),
      lastPollAt: null,
      pollCount: 0,
      errorCount: 0,
      events: [],
      running: true,
      lastSnapshot: null,
      timer: null,
    };

    this.sessions.set(id, session);
    this.scheduleNextPoll(session);
    return id;
  }

  /**
   * Para uma sessão de monitoramento ativa.
   * Retorna true se a sessão existia e foi parada, false se não encontrada.
   */
  stopWatch(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.cancelSession(session);
    return true;
  }

  /**
   * Retorna o status atual de uma sessão (ou null se não existir).
   */
  getStatus(id: string): HlsWatchStatus | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return toStatus(session);
  }

  /**
   * Lista todas as sessões ativas e encerradas.
   */
  listWatches(): HlsWatchStatus[] {
    return [...this.sessions.values()].map(toStatus);
  }

  /**
   * Para todas as sessões ativas (útil para shutdown graceful).
   */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      if (session.running) {
        this.cancelSession(session);
      }
    }
  }

  // ─── Privado ──────────────────────────────────────────────────────────────

  private scheduleNextPoll(session: WatchSession): void {
    if (!session.running) return;
    session.timer = setTimeout(() => {
      void this.poll(session);
    }, session.pollIntervalMs);
  }

  private async poll(session: WatchSession): Promise<void> {
    if (!session.running) return;

    try {
      const fetchedAt = Date.now();
      const inspected = await this.inspect.inspectHls({
        url: session.url,
        maxSegments: 20,
        timeoutMs: session.timeoutMs,
      });

      session.pollCount += 1;
      session.lastPollAt = new Date().toISOString();

      const snapshot = toHlsSnapshot(inspected, fetchedAt);

      if (session.lastSnapshot !== null) {
        const newEvents = analyzeSnapshotTransition(session.lastSnapshot, snapshot);
        if (newEvents.length > 0) {
          for (const event of newEvents) {
            session.events.push(event);
          }
          // Rotaciona eventos antigos se exceder o limite
          if (session.events.length > session.maxEvents) {
            session.events = session.events.slice(session.events.length - session.maxEvents);
          }
        }
      }

      session.lastSnapshot = snapshot;
    } catch (error) {
      session.errorCount += 1;
      session.lastPollAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      session.events.push({
        code: "poll_error",
        severity: "error",
        summary: `Erro ao buscar manifesto: ${message}`,
        evidence: [`url=${session.url}`, `error=${message}`],
        detectedAt: new Date().toISOString(),
      });
    }

    // Verifica se atingiu o limite de polls
    if (
      session.maxPollCount !== undefined &&
      session.pollCount >= session.maxPollCount
    ) {
      this.cancelSession(session);
      return;
    }

    this.scheduleNextPoll(session);
  }

  private cancelSession(session: WatchSession): void {
    session.running = false;
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }
}

function toStatus(session: WatchSession): HlsWatchStatus {
  return {
    id: session.id,
    url: session.url,
    startedAt: session.startedAt,
    lastPollAt: session.lastPollAt,
    pollCount: session.pollCount,
    errorCount: session.errorCount,
    events: [...session.events],
    running: session.running,
  };
}
