import type { MediaInspector } from "../inspect.js";
import { analyzeOrigin } from "./analysis.js";
import { cloneDash } from "./clone-dash.js";
import { cloneHls } from "./clone-hls.js";
import { mutateOrigin } from "./mutation.js";
import { StreamerOriginStore } from "./origin-store.js";
import { serveLiveOrigin, serveOrigin } from "./origin-server.js";
import { probeOrigin } from "./probe.js";
import { SegmentDownloader } from "./segment-downloader.js";
import type {
  StreamerAnalyzeOptions,
  StreamerCloneInput,
  StreamerCloneResult,
  StreamerLiveServeHandle,
  StreamerLiveServeOptions,
  StreamerMutateInput,
  StreamerMutateResult,
  StreamerOriginAnalysisReport,
  StreamerOriginProbeReport,
  StreamerOriginSummary,
  StreamerProbeOptions,
  StreamerRemoveResult,
  StreamerServeHandle,
  StreamerServeOptions,
} from "./model.js";

type StreamerInspectService = Pick<MediaInspector, "inspectHls"> &
  Partial<Pick<MediaInspector, "inspectDash">> &
  Partial<Pick<MediaInspector, "probe">>;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class StreamerService {
  private readonly originStore: StreamerOriginStore;
  private readonly downloader: SegmentDownloader;

  constructor(
    private readonly inspect: StreamerInspectService,
    private readonly rootDir: string,
    fetchImpl: FetchLike = fetch,
  ) {
    this.originStore = new StreamerOriginStore(rootDir);
    this.downloader = new SegmentDownloader(fetchImpl);
  }

  async init(): Promise<void> {
    await this.originStore.init();
  }

  async listOrigins(): Promise<StreamerOriginSummary[]> {
    return this.originStore.list();
  }

  async inspectOrigin(originId: string): Promise<StreamerCloneResult> {
    return this.originStore.load(originId);
  }

  async mutateOrigin(input: StreamerMutateInput): Promise<StreamerMutateResult> {
    return mutateOrigin(this.originStore, input);
  }

  async probeOrigin(
    originId: string,
    options: StreamerProbeOptions = {},
  ): Promise<StreamerOriginProbeReport> {
    return probeOrigin(this.originStore, this.inspect, originId, options);
  }

  async analyzeOrigin(
    originId: string,
    options: StreamerAnalyzeOptions = {},
  ): Promise<StreamerOriginAnalysisReport> {
    return analyzeOrigin(this.originStore, this.inspect, originId, options);
  }

  async removeOrigin(originId: string): Promise<StreamerRemoveResult> {
    return this.originStore.remove(originId);
  }

  async cloneHls(input: StreamerCloneInput): Promise<StreamerCloneResult> {
    return cloneHls({
      inspect: this.inspect,
      store: this.originStore,
      downloader: this.downloader,
      rootDir: this.rootDir,
      input,
    });
  }

  async cloneDash(input: StreamerCloneInput): Promise<StreamerCloneResult> {
    return cloneDash({
      inspect: this.inspect,
      store: this.originStore,
      downloader: this.downloader,
      rootDir: this.rootDir,
      input,
    });
  }

  async serveOrigin(
    originId: string,
    options: StreamerServeOptions = {},
  ): Promise<StreamerServeHandle> {
    return serveOrigin(this.originStore, originId, options);
  }

  async serveLiveOrigin(
    originId: string,
    options: StreamerLiveServeOptions = {},
  ): Promise<StreamerLiveServeHandle> {
    return serveLiveOrigin(this.originStore, originId, options);
  }
}
