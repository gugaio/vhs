import type { StreamerOriginFault } from "./clone-model.js";

export type StreamerOriginSummary = {
  id: string;
  schemaVersion: number;
  protocol?: "hls" | "dash";
  derivedFrom?: string;
  faults: StreamerOriginFault[];
  createdAt: string;
  sourceUrl: string;
  selectedUrl: string;
  rootDir: string;
  playbackPath: string;
  requestedDurationSeconds: number;
  requestedStartSeconds?: number;
  requestedStartSegment?: number;
  requestedSegmentCount?: number;
  cumulativeDurationSeconds: number;
  reachedTargetDuration: boolean;
  targetDuration: number;
  segmentCount: number;
  variantCount: number;
  renditionCount: number;
  bytes: number;
  allVariants: boolean;
};

export type StreamerRemoveResult = {
  id: string;
  rootDir: string;
  removed: boolean;
};

export type StreamerServeOptions = {
  host?: string;
  port?: number;
};

export type StreamerServeHandle = {
  originId: string;
  rootDir: string;
  baseUrl: string;
  playbackUrl: string;
  close(): Promise<void>;
};

export type StreamerLiveServeOptions = StreamerServeOptions & {
  /** Quantidade de segmentos expostos na janela live. Padrao: 5. */
  windowSize?: number;
  /** Sequencia inicial virtual para evitar edge cases com players que tratam zero de forma especial. */
  initialMediaSequence?: number;
};

export type StreamerLiveServeHandle = StreamerServeHandle & {
  windowSize: number;
  initialMediaSequence: number;
};
