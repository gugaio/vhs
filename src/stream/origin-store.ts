import fs from "node:fs/promises";
import path from "node:path";
import { isNodeError } from "./support.js";
import type {
  StreamerCloneResult,
  StreamerOriginSummary,
  StreamerRemoveResult,
} from "./model.js";

const STREAMER_ORIGIN_SCHEMA_VERSION = 2;

export class StreamerOriginStore {
  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async list(): Promise<StreamerOriginSummary[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    const origins: StreamerOriginSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        origins.push(toOriginSummary(await this.load(entry.name)));
      } catch {
        // Keep list resilient if a partially-written/corrupt origin exists.
      }
    }

    return origins.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async load(originId: string): Promise<StreamerCloneResult> {
    const id = sanitizeOriginId(originId);
    const originDir = path.join(this.rootDir, id);
    const raw = await fs.readFile(path.join(originDir, "origin.json"), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StreamerCloneResult>;
    if (!Array.isArray(parsed.variants) || parsed.variants.length === 0) {
      throw new Error(`streamer origin ${id} has no cloned variants`);
    }
    if (!Array.isArray(parsed.renditions)) {
      throw new Error(`streamer origin ${id} is not compatible with current schema`);
    }
    const clone = parsed as StreamerCloneResult;
    return {
      ...clone,
      id,
      schemaVersion: STREAMER_ORIGIN_SCHEMA_VERSION,
      rootDir: originDir,
    };
  }

  async save(origin: StreamerCloneResult): Promise<void> {
    await fs.writeFile(
      path.join(origin.rootDir, "origin.json"),
      `${JSON.stringify(origin, null, 2)}\n`,
      "utf-8",
    );
  }

  async remove(originId: string): Promise<StreamerRemoveResult> {
    const id = sanitizeOriginId(originId);
    const originDir = path.join(this.rootDir, id);
    await fs.rm(originDir, { recursive: true, force: false });
    return {
      id,
      rootDir: originDir,
      removed: true,
    };
  }
}

export function sanitizeOriginId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error("origin id must contain at least one safe character");
  }
  return sanitized.slice(0, 96);
}

function toOriginSummary(result: StreamerCloneResult): StreamerOriginSummary {
  return {
    id: result.id,
    schemaVersion: result.schemaVersion,
    protocol: result.protocol,
    derivedFrom: result.derivedFrom,
    faults: result.faults ?? [],
    createdAt: result.createdAt,
    sourceUrl: result.sourceUrl,
    selectedUrl: result.selectedUrl,
    rootDir: result.rootDir,
    playbackPath: result.playbackPath,
    requestedDurationSeconds: result.requestedDurationSeconds,
    requestedStartSeconds: result.requestedStartSeconds,
    requestedStartSegment: result.requestedStartSegment,
    requestedSegmentCount: result.requestedSegmentCount,
    cumulativeDurationSeconds: result.cumulativeDurationSeconds,
    reachedTargetDuration: result.reachedTargetDuration,
    targetDuration: result.targetDuration,
    segmentCount: result.segmentCount,
    variantCount: result.variantCount,
    renditionCount: result.renditionCount,
    bytes: result.bytes,
    allVariants: result.allVariants,
  };
}
