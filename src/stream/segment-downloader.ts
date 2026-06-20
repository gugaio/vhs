import { errorMessage, isAbortError } from "./support.js";
import type { StreamerCloneProgressEvent } from "./model.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ProgressEmitter = (event: StreamerCloneProgressEvent) => void;

export class SegmentDownloader {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async fetch(params: {
    url: string;
    timeoutMs: number;
    retries: number;
    progress: ProgressEmitter;
    variantIndex: number;
    variantCount: number;
    segmentIndex: number;
    segmentCount: number;
    originalSegmentIndex?: number;
  }): Promise<Uint8Array> {
    const maxAttempts = params.retries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.fetchOnce(params.url, params.timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) {
          break;
        }
        params.progress({
          type: "segment_download_retry",
          variantIndex: params.variantIndex,
          variantCount: params.variantCount,
          segmentIndex: params.segmentIndex,
          segmentCount: params.segmentCount,
          originalSegmentIndex: params.originalSegmentIndex,
          attempt: attempt + 1,
          maxAttempts,
          error: errorMessage(error),
        });
      }
    }

    throw new Error(
      `failed to download segment after ${maxAttempts} attempt(s): ${errorMessage(lastError)}`,
    );
  }

  private async fetchOnce(url: string, timeoutMs: number): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "VHS/0.1 (+streamer)" },
      });
      if (!response.ok) {
        throw new Error(`failed to download segment ${url}: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`segment download timed out after ${timeoutMs}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
