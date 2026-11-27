import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "./schemaJson.ts";

export const DATA_DIRECTORY_POINTER_FILENAME = ".quixotic-data-dir.json";

const DataDirectoryPointerSchema = Schema.Struct({
  version: Schema.Literal(1),
  baseDir: Schema.String,
  migratedFrom: Schema.optionalKey(Schema.String),
  migratedAt: Schema.optionalKey(Schema.String),
});

export type DataDirectoryPointer = typeof DataDirectoryPointerSchema.Type;

const decodePointerOption = Schema.decodeUnknownOption(fromLenientJson(DataDirectoryPointerSchema));

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_ABSOLUTE_PATTERN = /^\\\\[^\\/]+[\\/][^\\/]+/;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]*$/;

export function isAbsoluteDataDirectoryPath(
  rawPath: string,
  platform?: NodeJS.Platform,
): boolean {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return false;
  if (platform === "win32") {
    return (
      WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(trimmed) || WINDOWS_UNC_ABSOLUTE_PATTERN.test(trimmed)
    );
  }
  if (platform === undefined) {
    return (
      trimmed.startsWith("/") ||
      WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(trimmed) ||
      WINDOWS_UNC_ABSOLUTE_PATTERN.test(trimmed)
    );
  }
  return trimmed.startsWith("/");
}

export function isFilesystemRootPath(rawPath: string, platform: NodeJS.Platform): boolean {
  const trimmed = rawPath.trim();
  if (platform === "win32") {
    if (WINDOWS_DRIVE_ROOT_PATTERN.test(trimmed)) return true;
    // Bare UNC share root (\\server\share) without a subdirectory
    if (/^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/.test(trimmed)) return true;
    return false;
  }
  return /^\/+$/.test(trimmed);
}

export function stripTrailingSeparators(rawPath: string, platform: NodeJS.Platform): string {
  const trimmed = rawPath.trim();
  if (platform === "win32") {
    const normalized = trimmed.replace(/\//g, "\\");
    if (WINDOWS_DRIVE_ROOT_PATTERN.test(normalized)) {
      return `${normalized.slice(0, 2)}\\`;
    }
    return normalized.replace(/\\+$/, "");
  }
  if (/^\/+$/.test(trimmed)) return "/";
  return trimmed.replace(/\/+$/, "");
}

export function normalizeComparablePath(rawPath: string, platform: NodeJS.Platform): string {
  const trimmed = rawPath.trim();
  if (platform === "win32") {
    const slashed = trimmed.replace(/\\/g, "/");
    const stripped = /^[A-Za-z]:\/+$/.test(slashed)
      ? `${slashed.slice(0, 2)}/`
      : slashed.replace(/\/+$/, "");
    return stripped.toLowerCase();
  }
  if (/^\/+$/.test(trimmed)) return "/";
  return trimmed.replace(/\/+$/, "");
}

export function parseDataDirectoryPointer(
  raw: string,
  platform?: NodeJS.Platform,
): DataDirectoryPointer | null {
  const decoded = decodePointerOption(raw);
  if (Option.isNone(decoded)) return null;
  const baseDir = decoded.value.baseDir.trim();
  if (!isAbsoluteDataDirectoryPath(baseDir, platform)) return null;
  const migratedFrom = decoded.value.migratedFrom?.trim();
  const migratedAt = decoded.value.migratedAt?.trim();
  return {
    version: 1,
    baseDir,
    ...(migratedFrom && migratedFrom.length > 0 ? { migratedFrom } : {}),
    ...(migratedAt && migratedAt.length > 0 ? { migratedAt } : {}),
  };
}

export function serializeDataDirectoryPointer(pointer: {
  readonly baseDir: string;
  readonly migratedFrom?: string | undefined;
  readonly migratedAt?: string | undefined;
}): string {
  const payload: Record<string, unknown> = {
    version: 1,
    baseDir: pointer.baseDir,
  };
  if (pointer.migratedFrom && pointer.migratedFrom.trim().length > 0) {
    payload.migratedFrom = pointer.migratedFrom.trim();
  }
  if (pointer.migratedAt && pointer.migratedAt.trim().length > 0) {
    payload.migratedAt = pointer.migratedAt.trim();
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export type DataDirectoryTargetValidationError =
  | "empty"
  | "not-absolute"
  | "root-directory"
  | "same-directory"
  | "nested-inside-current"
  | "contains-current";

export type DataDirectoryTargetValidationResult =
  | { readonly ok: true; readonly normalizedTarget: string }
  | { readonly ok: false; readonly reason: DataDirectoryTargetValidationError };

export function validateDataDirectoryTarget(input: {
  readonly currentBaseDir: string;
  readonly targetBaseDir: string;
  readonly platform: NodeJS.Platform;
}): DataDirectoryTargetValidationResult {
  const trimmed = input.targetBaseDir.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (!isAbsoluteDataDirectoryPath(trimmed, input.platform)) {
    return { ok: false, reason: "not-absolute" };
  }
  if (isFilesystemRootPath(trimmed, input.platform)) {
    return { ok: false, reason: "root-directory" };
  }

  const currentNorm = normalizeComparablePath(input.currentBaseDir, input.platform);
  const targetNorm = normalizeComparablePath(trimmed, input.platform);

  if (currentNorm === targetNorm) {
    return { ok: false, reason: "same-directory" };
  }
  const currentPrefix = currentNorm.endsWith("/") ? currentNorm : `${currentNorm}/`;
  if (targetNorm.startsWith(currentPrefix)) {
    return { ok: false, reason: "nested-inside-current" };
  }
  const targetPrefix = targetNorm.endsWith("/") ? targetNorm : `${targetNorm}/`;
  if (currentNorm.startsWith(targetPrefix)) {
    return { ok: false, reason: "contains-current" };
  }

  return {
    ok: true,
    normalizedTarget: stripTrailingSeparators(trimmed, input.platform),
  };
}
