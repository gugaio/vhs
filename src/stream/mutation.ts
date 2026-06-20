import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./support.js";
import type {
  StreamerCloneResult,
  StreamerClonedRendition,
  StreamerClonedVariant,
  StreamerMutateInput,
  StreamerMutateResult,
  StreamerOriginFault,
} from "./model.js";
import { minVariantDuration } from "./clone-utils.js";
import { sanitizeOriginId, type StreamerOriginStore } from "./origin-store.js";

export async function mutateOrigin(
  store: StreamerOriginStore,
  input: StreamerMutateInput,
): Promise<StreamerMutateResult> {
  const source = await store.load(input.originId);
  const newId = sanitizeOriginId(input.newOriginId?.trim() || randomUUID());
  const newRootDir = path.join(path.dirname(source.rootDir), newId);
  if (newId === source.id || await pathExists(newRootDir)) {
    throw new Error(`streamer origin ${newId} already exists`);
  }
  await fs.cp(source.rootDir, newRootDir, { recursive: true, errorOnExist: false, force: true });

  const mutated = rebaseCloneResult(source, newId, newRootDir);
  const targetKind = input.targetKind ?? "variant";
  const targetIndex = Math.max(0, Math.floor(input.targetIndex ?? 0));
  const segmentIndex = Math.max(0, Math.floor(input.segmentIndex));
  const target = resolveMutationTarget(mutated, targetKind, targetIndex);
  if (segmentIndex >= target.segments.length) {
    throw new Error(`${targetKind}[${targetIndex}] has no segment ${segmentIndex}`);
  }
  const createdAt = new Date().toISOString();
  let fault: StreamerOriginFault;

  switch (input.fault) {
    case "discontinuity":
      await injectDiscontinuityIntoManifest(target.manifestPath, segmentIndex);
      fault = {
        type: "discontinuity",
        targetKind,
        targetIndex,
        segmentIndex,
        description: `Inserted EXT-X-DISCONTINUITY before ${targetKind}[${targetIndex}] segment ${segmentIndex}`,
        createdAt,
      };
      break;
    case "segment-swap":
      fault = await applySegmentSwapMutation(store, {
        mutated,
        targetKind,
        targetIndex,
        segmentIndex,
        donorOriginId: input.donorOriginId,
        donorTargetKind: input.donorTargetKind,
        donorTargetIndex: input.donorTargetIndex,
        donorSegmentIndex: input.donorSegmentIndex,
        withDiscontinuity: input.withDiscontinuity,
        ffmpegProfile: input.ffmpegProfile,
        createdAt,
      });
      break;
    default:
      throw new Error(`unsupported streamer fault: ${input.fault}`);
  }

  mutated.derivedFrom = source.id;
  mutated.faults = [...(source.faults ?? []), fault];
  mutated.createdAt = createdAt;
  mutated.segments = mutated.variants.flatMap((variant) => variant.segments);
  await store.save(mutated);
  return { sourceOriginId: source.id, origin: mutated, fault };
}

function rebaseCloneResult(source: StreamerCloneResult, id: string, rootDir: string): StreamerCloneResult {
  const rebaseManifestPath = (manifestPath: string): string =>
    path.join(rootDir, path.relative(source.rootDir, manifestPath));
  return {
    ...source,
    id,
    rootDir,
    manifestPath: rebaseManifestPath(source.manifestPath),
    variants: source.variants.map((variant) => ({
      ...variant,
      manifestPath: rebaseManifestPath(variant.manifestPath),
      segments: variant.segments.map((segment) => ({ ...segment })),
      maps: variant.maps.map((map) => ({ ...map })),
    })),
    renditions: source.renditions.map((rendition) => ({
      ...rendition,
      manifestPath: rebaseManifestPath(rendition.manifestPath),
      segments: rendition.segments.map((segment) => ({ ...segment })),
      maps: rendition.maps.map((map) => ({ ...map })),
    })),
    segments: source.segments.map((segment) => ({ ...segment })),
  };
}

function resolveMutationTarget(
  clone: StreamerCloneResult,
  kind: "variant" | "rendition",
  index: number,
): StreamerClonedVariant | StreamerClonedRendition {
  const target = kind === "variant" ? clone.variants[index] : clone.renditions[index];
  if (!target) throw new Error(`invalid mutation target ${kind}[${index}]`);
  return target;
}

async function injectDiscontinuityIntoManifest(manifestPath: string, segmentIndex: number): Promise<void> {
  const lines = (await fs.readFile(manifestPath, "utf-8")).split(/\r?\n/);
  const out: string[] = [];
  let mediaSegmentIndex = 0;
  let pendingExtinfIndex: number | null = null;
  let inserted = false;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      pendingExtinfIndex = out.length;
      out.push(line);
      continue;
    }
    if (line.trim() && !line.startsWith("#")) {
      if (mediaSegmentIndex === segmentIndex) {
        const insertAt = pendingExtinfIndex ?? out.length;
        if (out[insertAt - 1] !== "#EXT-X-DISCONTINUITY") {
          out.splice(insertAt, 0, "#EXT-X-DISCONTINUITY");
        }
        inserted = true;
      }
      mediaSegmentIndex += 1;
      pendingExtinfIndex = null;
    }
    out.push(line);
  }
  if (!inserted) throw new Error(`manifest ${manifestPath} has no segment ${segmentIndex}`);
  await fs.writeFile(manifestPath, out.join("\n"), "utf-8");
}

async function applySegmentSwapMutation(
  store: StreamerOriginStore,
  params: {
    mutated: StreamerCloneResult;
    targetKind: "variant" | "rendition";
    targetIndex: number;
    segmentIndex: number;
    donorOriginId?: string;
    donorTargetKind?: "variant" | "rendition";
    donorTargetIndex?: number;
    donorSegmentIndex?: number;
    withDiscontinuity?: boolean;
    ffmpegProfile?: "hevc";
    createdAt: string;
  },
): Promise<StreamerOriginFault> {
  const donorOriginId = params.donorOriginId?.trim();
  if (!donorOriginId) throw new Error("segment-swap requires donorOriginId");

  const donor = await store.load(donorOriginId);
  const donorTargetKind = params.donorTargetKind ?? params.targetKind;
  const donorTargetIndex = Math.max(0, Math.floor(params.donorTargetIndex ?? 0));
  const donorSegmentIndex = Math.max(0, Math.floor(params.donorSegmentIndex ?? params.segmentIndex));
  const target = resolveMutationTarget(params.mutated, params.targetKind, params.targetIndex);
  const donorTarget = resolveMutationTarget(donor, donorTargetKind, donorTargetIndex);
  if (donorSegmentIndex >= donorTarget.segments.length) {
    throw new Error(`${donorTargetKind}[${donorTargetIndex}] has no donor segment ${donorSegmentIndex}`);
  }

  const targetSegment = target.segments[params.segmentIndex];
  const donorSegment = donorTarget.segments[donorSegmentIndex];
  if (donorSegment.map) {
    throw new Error("segment-swap does not support donor segments with EXT-X-MAP yet");
  }
  const targetPath = path.join(path.dirname(target.manifestPath), targetSegment.localUri);
  const donorPath = path.join(path.dirname(donorTarget.manifestPath), donorSegment.localUri);
  const donorBytes = params.ffmpegProfile
    ? await transcodeDonorSegmentWithFfmpeg(donorPath, targetPath, params.ffmpegProfile)
    : await fs.readFile(donorPath);
  await fs.writeFile(targetPath, donorBytes);

  const previousBytes = targetSegment.bytes;
  Object.assign(targetSegment, {
    sourceUri: donorSegment.sourceUri,
    sourceUrl: donorSegment.sourceUrl,
    duration: donorSegment.duration,
    title: donorSegment.title,
    bytes: donorBytes.byteLength,
    map: undefined,
  });
  const byteDelta = donorBytes.byteLength - previousBytes;
  target.bytes += byteDelta;
  params.mutated.bytes += byteDelta;
  target.cumulativeDurationSeconds = target.segments.reduce((sum, segment) => sum + (segment.duration ?? 0), 0);
  target.targetDuration = Math.max(1, ...target.segments.map((segment) => Math.ceil(segment.duration ?? 0)));
  params.mutated.cumulativeDurationSeconds = minVariantDuration(params.mutated.variants);
  params.mutated.targetDuration = Math.max(...params.mutated.variants.map((variant) => variant.targetDuration), 1);

  const manifest = await fs.readFile(target.manifestPath, "utf-8");
  await fs.writeFile(
    target.manifestPath,
    replaceManifestSegmentDuration(manifest, params.segmentIndex, donorSegment.duration),
    "utf-8",
  );
  if (params.withDiscontinuity) {
    await injectDiscontinuityIntoManifest(target.manifestPath, params.segmentIndex);
  }

  return {
    type: "segment-swap",
    targetKind: params.targetKind,
    targetIndex: params.targetIndex,
    segmentIndex: params.segmentIndex,
    description: `Swapped ${params.targetKind}[${params.targetIndex}] segment ${params.segmentIndex} with ${donor.id} ${donorTargetKind}[${donorTargetIndex}] segment ${donorSegmentIndex}${params.ffmpegProfile ? ` transcoded=${params.ffmpegProfile}` : ""}${params.withDiscontinuity ? " and inserted EXT-X-DISCONTINUITY" : ""}`,
    createdAt: params.createdAt,
    donorOriginId: donor.id,
    donorTargetKind,
    donorTargetIndex,
    donorSegmentIndex,
    withDiscontinuity: Boolean(params.withDiscontinuity),
  };
}

function replaceManifestSegmentDuration(text: string, segmentIndex: number, duration: number | undefined): string {
  if (typeof duration !== "number") return text;
  const lines = text.split(/\r?\n/);
  let mediaSegmentIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("#EXTINF:")) continue;
    const nextLine = lines[index + 1];
    if (!nextLine || !nextLine.trim() || nextLine.startsWith("#")) continue;
    if (mediaSegmentIndex === segmentIndex) {
      const title = line.slice("#EXTINF:".length).split(",").slice(1).join(",");
      lines[index] = `#EXTINF:${duration.toFixed(3)},${title}`;
      return `${lines.join("\n")}${text.endsWith("\n") ? "\n" : ""}`;
    }
    mediaSegmentIndex += 1;
  }
  return text;
}

async function transcodeDonorSegmentWithFfmpeg(
  donorPath: string,
  targetPath: string,
  profile: "hevc",
): Promise<Buffer> {
  const tempOutputPath = `${targetPath}.ffmpeg-swap.ts`;
  const args = profile === "hevc"
    ? [
        "-y", "-i", donorPath,
        "-c:v", "libx265",
        "-preset", "ultrafast",
        "-x265-params", "keyint=25:min-keyint=25:scenecut=0",
        "-c:a", "aac",
        "-f", "mpegts",
        tempOutputPath,
      ]
    : [];
  const result = spawnSync("ffmpeg", args, {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `ffmpeg exited with ${String(result.status)}`);
  }
  try {
    return await fs.readFile(tempOutputPath);
  } finally {
    await fs.rm(tempOutputPath, { force: true }).catch(() => undefined);
  }
}
