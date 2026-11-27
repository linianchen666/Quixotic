import {
  type DesktopDataDirectoryMigrateInput,
  type DesktopDataDirectoryMigrateResult,
  type DesktopDataDirectoryState,
} from "@t3tools/contracts";
import {
  DATA_DIRECTORY_POINTER_FILENAME,
  normalizeComparablePath,
  parseDataDirectoryPointer,
  serializeDataDirectoryPointer,
  validateDataDirectoryTarget,
  type DataDirectoryTargetValidationError,
} from "@t3tools/shared/dataDirectory";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import { desktopStateDatabase, resolveDefaultDesktopBaseDir } from "./DesktopStatePaths.ts";

const { logInfo, logWarning, logError } = makeComponentLogger("desktop-data-directory");

const EPHEMERAL_FILENAMES = new Set([
  "server-runtime.json",
  "desktop-update-in-progress.json",
]);

function isEphemeralFile(name: string): boolean {
  if (EPHEMERAL_FILENAMES.has(name)) return true;
  if (name.endsWith(".lock") || name.endsWith(".pid")) return true;
  return false;
}

function isLogRelativePath(relativeParts: readonly string[]): boolean {
  return (
    relativeParts[0] === "logs" ||
    (relativeParts[0] === "userdata" && relativeParts[1] === "logs") ||
    (relativeParts[0] === "dev" && relativeParts[1] === "logs")
  );
}

function formatValidationError(reason: DataDirectoryTargetValidationError): string {
  switch (reason) {
    case "empty":
      return "Please select or enter a target folder path.";
    case "not-absolute":
      return "The target path must be an absolute directory path (for example, D:\\QuixoticData).";
    case "root-directory":
      return "Please choose a dedicated subfolder instead of a drive or filesystem root.";
    case "same-directory":
      return "The selected folder is already the current user data directory.";
    case "nested-inside-current":
      return "The target folder cannot be inside the current user data directory.";
    case "contains-current":
      return "The target folder cannot be a parent of the current user data directory.";
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class DesktopDataDirectory extends Context.Service<
  DesktopDataDirectory,
  {
    readonly getState: Effect.Effect<DesktopDataDirectoryState>;
    readonly migrate: (
      input: DesktopDataDirectoryMigrateInput,
    ) => Effect.Effect<DesktopDataDirectoryMigrateResult>;
    readonly openFolder: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopDataDirectory") {}

const computeDirectorySize = Effect.fn("desktop.dataDirectory.computeSize")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootDir: string,
): Effect.fn.Return<number | null> {
  const rootExists = yield* fs.exists(rootDir).pipe(Effect.orElseSucceed(() => false));
  if (!rootExists) return null;

  let totalBytes = 0;
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      const info = yield* fs.lstat(fullPath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory") {
        stack.push(fullPath);
      } else if (info.value.type === "File") {
        totalBytes += Number(info.value.size);
      }
    }
  }

  return totalBytes;
});

const copyDirectoryRecursive = Effect.fn("desktop.dataDirectory.copyRecursive")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
): Effect.fn.Return<void, string> {
  yield* fs
    .makeDirectory(targetRoot, { recursive: true })
    .pipe(Effect.mapError((error) => `Failed to create target directory: ${formatUnknownError(error)}`));

  const queue: Array<{ readonly rel: readonly string[] }> = [{ rel: [] }];

  while (queue.length > 0) {
    const { rel } = queue.shift()!;
    const srcDir = rel.length === 0 ? sourceRoot : path.join(sourceRoot, ...rel);
    const dstDir = rel.length === 0 ? targetRoot : path.join(targetRoot, ...rel);

    const entries = yield* fs.readDirectory(srcDir).pipe(
      Effect.mapError((error) => `Failed to read "${srcDir}": ${formatUnknownError(error)}`),
    );

    for (const entry of entries) {
      if (isEphemeralFile(entry)) continue;
      const entryRel = [...rel, entry];
      const srcPath = path.join(srcDir, entry);
      const dstPath = path.join(dstDir, entry);

      const info = yield* fs.lstat(srcPath).pipe(
        Effect.mapError((error) => `Failed to inspect "${srcPath}": ${formatUnknownError(error)}`),
      );

      if (info.type === "Directory") {
        yield* fs
          .makeDirectory(dstPath, { recursive: true })
          .pipe(
            Effect.mapError((error) => `Failed to create "${dstPath}": ${formatUnknownError(error)}`),
          );
        queue.push({ rel: entryRel });
        continue;
      }

      if (info.type === "SymbolicLink") {
        const linkTarget = yield* fs.readLink(srcPath).pipe(Effect.option);
        if (Option.isSome(linkTarget)) {
          yield* fs.remove(dstPath, { force: true }).pipe(Effect.ignore);
          yield* fs.symlink(linkTarget.value, dstPath).pipe(
            Effect.catch(() =>
              // Fall back to copying the resolved file if symlinks require elevated privileges on Windows.
              fs.copyFile(srcPath, dstPath).pipe(Effect.ignore),
            ),
          );
        }
        continue;
      }

      if (info.type === "File") {
        const copyResult = yield* fs.copyFile(srcPath, dstPath).pipe(Effect.result);
        if (Result.isFailure(copyResult)) {
          if (isLogRelativePath(entryRel)) {
            yield* logWarning("skipping busy log file during data directory migration", {
              srcPath,
              error: formatUnknownError(copyResult.failure),
            });
            continue;
          }
          return yield* Effect.fail(
            `Failed to copy "${entryRel.join("/")}": ${formatUnknownError(copyResult.failure)}`,
          );
        }
      }
    }
  }
});

const verifyCopiedData = Effect.fn("desktop.dataDirectory.verifyCopiedData")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  sourceRoot: string,
  targetRoot: string,
): Effect.fn.Return<void, string> {
  const criticalRelativePaths = [
    path.join("userdata", "statev2.sqlite"),
    path.join("userdata", "settings.json"),
    path.join("userdata", "desktop-settings.json"),
  ];

  for (const rel of criticalRelativePaths) {
    const srcPath = path.join(sourceRoot, rel);
    const dstPath = path.join(targetRoot, rel);
    const srcInfo = yield* fs.stat(srcPath).pipe(Effect.option);
    if (Option.isNone(srcInfo) || srcInfo.value.type !== "File") continue;

    const dstInfo = yield* fs.stat(dstPath).pipe(Effect.option);
    if (Option.isNone(dstInfo) || dstInfo.value.type !== "File") {
      return yield* Effect.fail(`Verification failed: "${rel}" is missing in the target directory.`);
    }
    if (srcInfo.value.size > 0n && dstInfo.value.size === 0n) {
      return yield* Effect.fail(`Verification failed: "${rel}" in the target directory is empty.`);
    }
  }
});

const removeDirectoryBestEffort = Effect.fn("desktop.dataDirectory.removeBestEffort")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
): Effect.fn.Return<boolean> {
  const direct = yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.result);
  if (Result.isSuccess(direct)) return true;

  // On Windows, an open log file handle in the main process can block removing the root folder
  // while still allowing almost all space (databases, providers, caches, worktrees) to be freed.
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const info = yield* fs.lstat(fullPath).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") {
      yield* removeDirectoryBestEffort(fs, path, fullPath);
    } else {
      yield* fs.remove(fullPath, { force: true }).pipe(Effect.ignore);
    }
  }
  const finalRetry = yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.result);
  return Result.isSuccess(finalRetry);
});

export const layer = Layer.effect(
  DesktopDataDirectory,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const config = yield* DesktopConfig.DesktopConfig;
    const backendPool = yield* DesktopBackendPool.DesktopBackendPool;
    const electronShell = yield* ElectronShell.ElectronShell;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationLock = yield* Semaphore.make(1);

    const pointerPath = path.join(environment.homeDirectory, DATA_DIRECTORY_POINTER_FILENAME);

    const resolveDefaultBaseDir = Effect.fn("desktop.dataDirectory.resolveDefaultBaseDir")(
      function* () {
        const statePaths = new Set<string>();
        for (const name of [".quixotic", ".t3"]) {
          const database = desktopStateDatabase(
            path.join(environment.homeDirectory, name),
            path.join,
          );
          if (yield* fs.exists(database).pipe(Effect.orElseSucceed(() => false))) {
            statePaths.add(database);
          }
        }
        return resolveDefaultDesktopBaseDir({
          homeDirectory: environment.homeDirectory,
          joinPath: path.join,
          hasState: (file) => statePaths.has(file),
        });
      },
    );

    const hasExistingData = Effect.fn("desktop.dataDirectory.hasExistingData")(function* (
      dir: string,
    ) {
      const stateDb = desktopStateDatabase(dir, path.join);
      if (yield* fs.exists(stateDb).pipe(Effect.orElseSucceed(() => false))) {
        return true;
      }
      const userdataDir = path.join(dir, "userdata");
      const entries = yield* fs
        .readDirectory(userdataDir)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      return entries.some((entry) => !isEphemeralFile(entry));
    });

    const getState = Effect.fn("desktop.dataDirectory.getState")(function* () {
      const envOverrideValue = Option.getOrNull(config.t3Home);
      const overriddenByEnv = envOverrideValue !== null;
      const defaultBaseDir = yield* resolveDefaultBaseDir();
      const pointerRaw = yield* fs.readFileString(pointerPath).pipe(Effect.option);
      const pointer = Option.isSome(pointerRaw)
        ? parseDataDirectoryPointer(pointerRaw.value, environment.platform)
        : null;
      const isCustom =
        !overriddenByEnv &&
        (pointer !== null ||
          normalizeComparablePath(environment.baseDir, environment.platform) !==
            normalizeComparablePath(defaultBaseDir, environment.platform));
      const sizeBytes = yield* computeDirectorySize(fs, path, environment.baseDir);

      return {
        currentBaseDir: environment.baseDir,
        defaultBaseDir,
        isCustom,
        overriddenByEnv,
        envOverrideValue,
        sizeBytes,
        pointerPath,
        previousBaseDir: pointer?.migratedFrom ?? null,
      } satisfies DesktopDataDirectoryState;
    });

    const writePointerAtomically = Effect.fn("desktop.dataDirectory.writePointer")(function* (
      targetBaseDir: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const migratedAt = DateTime.formatIso(yield* DateTime.now);
      const content = serializeDataDirectoryPointer({
        baseDir: targetBaseDir,
        migratedFrom: environment.baseDir,
        migratedAt,
      });
      const tmpPath = `${pointerPath}.${now}.tmp`;
      yield* fs.writeFileString(tmpPath, content);
      yield* fs.rename(tmpPath, pointerPath).pipe(
        Effect.catch(() =>
          // On Windows, rename over an existing file can fail on some filesystems; fall back to direct write.
          fs
            .writeFileString(pointerPath, content)
            .pipe(Effect.ensuring(fs.remove(tmpPath, { force: true }).pipe(Effect.ignore))),
        ),
      );
    });

    const migrateInternal = Effect.fn("desktop.dataDirectory.migrate")(function* (
      input: DesktopDataDirectoryMigrateInput,
    ): Effect.fn.Return<DesktopDataDirectoryMigrateResult> {
      const fail = (
        error: string,
        extra?: { readonly targetHadExistingData?: boolean },
      ): DesktopDataDirectoryMigrateResult => ({
        ok: false,
        baseDir: environment.baseDir,
        previousBaseDir: environment.baseDir,
        deletedSource: false,
        relaunching: false,
        ...(extra?.targetHadExistingData !== undefined
          ? { targetHadExistingData: extra.targetHadExistingData }
          : {}),
        error,
      });

      if (Option.isSome(config.t3Home)) {
        return fail(
          "The data directory is controlled by the T3CODE_HOME environment variable. Clear T3CODE_HOME to change it here.",
        );
      }
      if (environment.isDevelopment) {
        return fail("Data directory migration is unavailable in development mode.");
      }

      const defaultBaseDir = yield* resolveDefaultBaseDir();
      let targetBaseDir: string;

      if (input.mode === "reset") {
        if (
          normalizeComparablePath(environment.baseDir, environment.platform) ===
          normalizeComparablePath(defaultBaseDir, environment.platform)
        ) {
          yield* fs.remove(pointerPath, { force: true }).pipe(Effect.ignore);
          return {
            ok: true,
            baseDir: defaultBaseDir,
            previousBaseDir: environment.baseDir,
            deletedSource: false,
            relaunching: false,
          };
        }
        targetBaseDir = defaultBaseDir;
      } else {
        const validation = validateDataDirectoryTarget({
          currentBaseDir: environment.baseDir,
          targetBaseDir: input.targetBaseDir ?? "",
          platform: environment.platform,
        });
        if (!validation.ok) {
          return fail(formatValidationError(validation.reason));
        }
        targetBaseDir = validation.normalizedTarget;
      }

      const targetHadExistingData = yield* hasExistingData(targetBaseDir);
      if (input.mode === "migrate" && targetHadExistingData) {
        return fail(
          "The selected folder already contains Quixotic data. Choose an empty folder to migrate, or switch directly to use the existing data.",
          { targetHadExistingData: true },
        );
      }

      // Verify target directory can be created and written before stopping any running backends.
      const now = yield* Clock.currentTimeMillis;
      const probePath = path.join(targetBaseDir, `.quixotic-write-probe-${now}`);
      const writableCheck = yield* fs.makeDirectory(targetBaseDir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(probePath, "ok")),
        Effect.andThen(fs.remove(probePath, { force: true })),
        Effect.result,
      );
      if (Result.isFailure(writableCheck)) {
        return fail(
          `Cannot write to "${targetBaseDir}": ${formatUnknownError(writableCheck.failure)}`,
        );
      }

      yield* logInfo("stopping local backends before data directory change", {
        mode: input.mode,
        from: environment.baseDir,
        to: targetBaseDir,
      });

      const instances = yield* backendPool.list;
      yield* Effect.forEach(
        instances,
        (instance) =>
          instance
            .stop({ timeout: DesktopBackendManager.BACKEND_QUIT_STOP_TIMEOUT })
            .pipe(Effect.ignore),
        { concurrency: "unbounded" },
      );

      const shouldCopy =
        input.mode === "migrate" || (input.mode === "reset" && !targetHadExistingData);

      if (shouldCopy) {
        const sourceExists = yield* fs
          .exists(environment.baseDir)
          .pipe(Effect.orElseSucceed(() => false));
        if (sourceExists) {
          const copyResult = yield* copyDirectoryRecursive(
            fs,
            path,
            environment.baseDir,
            targetBaseDir,
          ).pipe(
            Effect.andThen(verifyCopiedData(fs, path, environment.baseDir, targetBaseDir)),
            Effect.result,
          );
          if (Result.isFailure(copyResult)) {
            yield* logError("data directory migration copy failed; keeping original location", {
              from: environment.baseDir,
              to: targetBaseDir,
              error: copyResult.failure,
            });
            return fail(copyResult.failure);
          }
        }
      }

      const pointerUpdate =
        input.mode === "reset"
          ? yield* fs.remove(pointerPath, { force: true }).pipe(Effect.result)
          : yield* writePointerAtomically(targetBaseDir).pipe(Effect.result);

      if (Result.isFailure(pointerUpdate)) {
        yield* logError("failed to update data directory pointer file", {
          pointerPath,
          error: formatUnknownError(pointerUpdate.failure),
        });
        return fail(
          `Failed to save data directory setting: ${formatUnknownError(pointerUpdate.failure)}`,
        );
      }

      let deletedSource = false;
      if (shouldCopy && input.deleteSource === true) {
        deletedSource = yield* removeDirectoryBestEffort(fs, path, environment.baseDir);
        if (!deletedSource) {
          yield* logWarning("some files in the old data directory could not be removed immediately", {
            previousBaseDir: environment.baseDir,
          });
        }
      }

      yield* logInfo("data directory updated; relaunch scheduled", {
        mode: input.mode,
        previousBaseDir: environment.baseDir,
        baseDir: targetBaseDir,
        deletedSource,
      });

      return {
        ok: true,
        baseDir: targetBaseDir,
        previousBaseDir: environment.baseDir,
        deletedSource,
        targetHadExistingData,
        relaunching: true,
      };
    });

    const openFolder = Effect.fn("desktop.dataDirectory.openFolder")(function* () {
      yield* fs.makeDirectory(environment.baseDir, { recursive: true }).pipe(Effect.ignore);
      return yield* electronShell.openPath(environment.baseDir);
    });

    return DesktopDataDirectory.of({
      getState: getState(),
      migrate: Effect.fn("DesktopDataDirectory.migrate")((input) =>
        migrationLock.withPermits(1)(migrateInternal(input)),
      ),
      openFolder: openFolder(),
    });
  }),
);
