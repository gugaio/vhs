export type StreamerCloneInput = {
  url: string;
  /** Formato do manifesto de entrada. Auto usa a extensao da URL quando possivel. */
  format?: "auto" | "hls" | "dash";
  /** Duração alvo em segundos. O clone inclui segmentos até cumulative >= alvo. */
  durationSeconds?: number;
  /** Offset aproximado em segundos para iniciar a janela clonada. */
  startSeconds?: number;
  /** Indice zero-based do primeiro segmento original a clonar. */
  startSegment?: number;
  /** Quantidade exata de segmentos a clonar a partir da janela escolhida. */
  segmentCount?: number;
  /** Para master playlists: aac-highest (default), highest, lowest ou índice zero-based da variant. */
  variant?: string;
  /** Quando true, clona todas as variants da master playlist e gera uma master local. */
  allVariants?: boolean;
  /** Limite opcional de variants quando `allVariants` estiver ativo. */
  maxVariants?: number;
  timeoutMs?: number;
  /** Timeout por segmento em ms. Padrao maior que o timeout de manifesto porque chunks 4K podem ser pesados. */
  segmentTimeoutMs?: number;
  /** Quantidade de retries por segmento apos a primeira tentativa. */
  segmentRetries?: number;
  maxSegments?: number;
  originId?: string;
  onProgress?: (event: StreamerCloneProgressEvent) => void;
};

export type StreamerCloneProgressEvent =
  | {
      type: "start";
      originId: string;
      url: string;
      durationSeconds: number;
      startSeconds: number;
      startSegment?: number;
      segmentCount?: number;
      allVariants: boolean;
    }
  | {
      type: "manifest_fetch";
      url: string;
    }
  | {
      type: "manifest_ready";
      url: string;
      playlistType: "master" | "media" | "unknown" | "dash";
      variantCount: number;
      segmentCount: number;
    }
  | {
      type: "variant_inspect";
      variantIndex: number;
      variantCount: number;
      label: string;
      url: string;
    }
  | {
      type: "variant_ready";
      variantIndex: number;
      variantCount: number;
      label: string;
      segmentCount: number;
      targetDuration: number;
    }
  | {
      type: "segment_download_start";
      variantIndex: number;
      variantCount: number;
      segmentIndex: number;
      segmentCount: number;
      originalSegmentIndex?: number;
      url: string;
      duration?: number;
    }
  | {
      type: "segment_download_retry";
      variantIndex: number;
      variantCount: number;
      segmentIndex: number;
      segmentCount: number;
      originalSegmentIndex?: number;
      attempt: number;
      maxAttempts: number;
      error: string;
    }
  | {
      type: "segment_downloaded";
      variantIndex: number;
      variantCount: number;
      segmentIndex: number;
      segmentCount: number;
      originalSegmentIndex?: number;
      localUri: string;
      bytes: number;
      cumulativeBytes: number;
      cumulativeDurationSeconds: number;
    }
  | {
      type: "complete";
      originId: string;
      segmentCount: number;
      variantCount: number;
      bytes: number;
      cumulativeDurationSeconds: number;
    };

export type StreamerClonedSegment = {
  originalIndex: number;
  sourceUri: string;
  sourceUrl: string;
  localUri: string;
  duration?: number;
  timelineStartSeconds?: number;
  timelineEndSeconds?: number;
  title?: string;
  bytes: number;
  map?: StreamerClonedMap;
};

export type StreamerClonedMap = {
  sourceUri: string;
  sourceUrl: string;
  localUri: string;
  bytes: number;
};

export type StreamerClonedVariant = {
  sourceUri: string;
  sourceUrl: string;
  finalUrl: string;
  localUri: string;
  manifestPath: string;
  targetDuration: number;
  segmentCount: number;
  cumulativeDurationSeconds: number;
  reachedTargetDuration: boolean;
  bytes: number;
  maps: StreamerClonedMap[];
  variant?: {
    id?: string;
    uri: string;
    url: string;
    contentType?: string;
    mimeType?: string;
    bandwidth?: number;
    averageBandwidth?: number;
    resolution?: string;
    frameRate?: number;
    codecs?: string;
    audioGroupId?: string;
    subtitlesGroupId?: string;
    closedCaptions?: string;
  };
  segments: StreamerClonedSegment[];
};

export type StreamerClonedRendition = {
  type: string;
  id?: string;
  groupId?: string;
  name?: string;
  language?: string;
  codecs?: string;
  mimeType?: string;
  bandwidth?: number;
  audioSamplingRate?: number;
  default?: boolean;
  autoselect?: boolean;
  forced?: boolean;
  channels?: string;
  characteristics?: string;
  sourceUri: string;
  sourceUrl: string;
  finalUrl: string;
  localUri: string;
  manifestPath: string;
  targetDuration: number;
  segmentCount: number;
  cumulativeDurationSeconds: number;
  reachedTargetDuration: boolean;
  bytes: number;
  maps: StreamerClonedMap[];
  segments: StreamerClonedSegment[];
};

export type StreamerCloneResult = {
  id: string;
  schemaVersion: number;
  protocol?: "hls" | "dash";
  derivedFrom?: string;
  faults?: StreamerOriginFault[];
  sourceUrl: string;
  selectedUrl: string;
  finalUrl: string;
  rootDir: string;
  manifestPath: string;
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
  selectedVariant?: {
    id?: string;
    uri: string;
    url: string;
    contentType?: string;
    mimeType?: string;
    bandwidth?: number;
    averageBandwidth?: number;
    resolution?: string;
    frameRate?: number;
    codecs?: string;
    audioGroupId?: string;
    subtitlesGroupId?: string;
    closedCaptions?: string;
  };
  createdAt: string;
  variants: StreamerClonedVariant[];
  renditions: StreamerClonedRendition[];
  segments: StreamerClonedSegment[];
};

export type StreamerFaultTargetKind = "variant" | "rendition";

export type StreamerFaultType = "discontinuity" | "segment-swap";

export type StreamerOriginFault = {
  type: StreamerFaultType;
  targetKind: StreamerFaultTargetKind;
  targetIndex: number;
  segmentIndex: number;
  description: string;
  createdAt: string;
  donorOriginId?: string;
  donorTargetKind?: StreamerFaultTargetKind;
  donorTargetIndex?: number;
  donorSegmentIndex?: number;
  withDiscontinuity?: boolean;
};

export type StreamerMutateInput = {
  originId: string;
  fault: StreamerFaultType;
  targetKind?: StreamerFaultTargetKind;
  targetIndex?: number;
  segmentIndex: number;
  donorOriginId?: string;
  donorTargetKind?: StreamerFaultTargetKind;
  donorTargetIndex?: number;
  donorSegmentIndex?: number;
  withDiscontinuity?: boolean;
  ffmpegProfile?: "hevc";
  newOriginId?: string;
};

export type StreamerMutateResult = {
  sourceOriginId: string;
  origin: StreamerCloneResult;
  fault: StreamerOriginFault;
};
