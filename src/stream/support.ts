import fs from "node:fs/promises";
import path from "node:path";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value === undefined || !Number.isFinite(value) ? fallback : value));
}

export function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, fallback, min, max));
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}
