import path from "node:path";
import type { StreamerClonedVariant } from "./model.js";

export function buildSegmentFileName(index: number, uri: string): string {
  let basename = "";
  try {
    basename = path.basename(new URL(uri, "http://streamer.local").pathname);
  } catch {
    basename = path.basename(uri);
  }

  const safeBase = basename.replace(/[^a-zA-Z0-9._-]/g, "-") || "segment.ts";
  return `${String(index).padStart(5, "0")}-${safeBase}`;
}

export function minVariantDuration(variants: StreamerClonedVariant[]): number {
  return variants.length === 0
    ? 0
    : Math.min(...variants.map((variant) => variant.cumulativeDurationSeconds));
}
