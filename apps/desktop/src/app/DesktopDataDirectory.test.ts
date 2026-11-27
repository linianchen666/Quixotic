import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DATA_DIRECTORY_POINTER_FILENAME, parseDataDirectoryPointer } from "@t3tools/shared/dataDirectory";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopDataDirectory from "./DesktopDataDirectory.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeEnvironmentInput = (
  homeDirectory: string,
  platform: NodeJS.Platform,
  processArch: string,
) => ({
  dirname: "/app/apps/desktop/dist",
  homeDirectory,
  platform,
  processArch,
  appVersion: "0.1.14-beta.4",
  appPath: "/app",
  isPackaged: true,
  resourcesPath: "/app/resources",
  runningUnderArm64Translation: false,
});

const makeLayer = (input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onStop?: () => void;
  readonly onOpenPath?: (targetPath: string) => void;
}) => {
  const backendInstance = {
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    stop: () =>
      Effect.sync(() => {
        input.onStop?.();
      }),
  } as unknown as DesktopBackendManager.DesktopBackendInstance;

  const shellLayer = Layer.succeed(
    ElectronShell.ElectronShell,
    ElectronShell.ElectronShell.of({
      openExternal: () => Effect.succeed(false),
      openPath: (targetPath) =>
        Effect.sync(() => {
          input.onOpenPath?.(targetPath);
          return true;
        }),
      openSystemSettings: () => Effect.succeed(false),
      copyText: () => Effect.void,
    }),
  );

  const envLayer = DesktopEnvironment.layer(
    makeEnvironmentInput(input.homeDirectory, input.platform, input.processArch),
  ).pipe(Layer.provide(DesktopConfig.layerTest(input.env ?? {})));

  return DesktopDataDirectory.layer.pipe(
    Layer.provideMerge(envLayer),
    Layer.provide(DesktopConfig.layerTest(input.env ?? {})),
    Layer.provide(DesktopBackendPool.layerTest([backendInstance])),
    Layer.provide(shellLayer),
  );
};

it.layer(NodeServices.layer)("DesktopDataDirectory", (it) => {
  it.effect("migrates user data, writes pointer file, stops backends, and optionally deletes source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const processArch = yield* HostProcess.Architecture;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "quixotic-data-dir-" });
      const home = path.join(root, "home");
      const legacyBase = path.join(home, ".t3");
      const targetBase = path.join(root, "d-drive", "QuixoticData");

      yield* fs.makeDirectory(path.join(legacyBase, "userdata", "logs"), { recursive: true });
      yield* fs.writeFileString(path.join(legacyBase, "userdata", "statev2.sqlite"), "sqlite-bytes");
      yield* fs.writeFileString(path.join(legacyBase, "userdata", "settings.json"), '{"ok":true}');
      yield* fs.writeFileString(path.join(legacyBase, "userdata", "server-runtime.json"), '{"pid":1}');

      let stopCalls = 0;
      let openedPath: string | null = null;

      const result = yield* Effect.gen(function* () {
        const service = yield* DesktopDataDirectory.DesktopDataDirectory;
        const initialState = yield* service.getState;
        assert.strictEqual(initialState.currentBaseDir, legacyBase);
        assert.strictEqual(initialState.isCustom, false);
        assert.strictEqual(initialState.overriddenByEnv, false);
        assert.isTrue((initialState.sizeBytes ?? 0) > 0);

        const opened = yield* service.openFolder;
        assert.strictEqual(opened, true);

        return yield* service.migrate({
          targetBaseDir: targetBase,
          mode: "migrate",
          deleteSource: true,
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            homeDirectory: home,
            platform,
            processArch,
            onStop: () => {
              stopCalls += 1;
            },
            onOpenPath: (dir) => {
              openedPath = dir;
            },
          }),
        ),
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.baseDir, targetBase);
      assert.strictEqual(result.previousBaseDir, legacyBase);
      assert.strictEqual(result.deletedSource, true);
      assert.strictEqual(result.relaunching, true);
      assert.strictEqual(stopCalls, 1);
      assert.strictEqual(openedPath, legacyBase);

      // Verify files copied and ephemeral runtime file excluded
      assert.strictEqual(
        yield* fs.readFileString(path.join(targetBase, "userdata", "statev2.sqlite")),
        "sqlite-bytes",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(targetBase, "userdata", "settings.json")),
        '{"ok":true}',
      );
      assert.strictEqual(
        yield* fs.exists(path.join(targetBase, "userdata", "server-runtime.json")),
        false,
      );
      // Old source deleted
      assert.strictEqual(yield* fs.exists(legacyBase), false);

      // Pointer file written and respected by DesktopEnvironment on next launch
      const pointerRaw = yield* fs.readFileString(path.join(home, DATA_DIRECTORY_POINTER_FILENAME));
      const parsed = parseDataDirectoryPointer(pointerRaw, platform);
      assert.strictEqual(parsed?.baseDir, targetBase);
      assert.strictEqual(parsed?.migratedFrom, legacyBase);

      const nextBaseDir = yield* Effect.gen(function* () {
        const env = yield* DesktopEnvironment.DesktopEnvironment;
        return env.baseDir;
      }).pipe(
        Effect.provide(
          DesktopEnvironment.layer(makeEnvironmentInput(home, platform, processArch)).pipe(
            Layer.provide(DesktopConfig.layerTest({})),
          ),
        ),
      );
      assert.strictEqual(nextBaseDir, targetBase);
    }),
  );

  it.effect("refuses migrate into non-empty target unless switched explicitly, and supports reset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const processArch = yield* HostProcess.Architecture;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "quixotic-data-dir-switch-" });
      const home = path.join(root, "home");
      const defaultBase = path.join(home, ".quixotic");
      const existingTarget = path.join(root, "existing-data");

      yield* fs.makeDirectory(path.join(defaultBase, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(defaultBase, "userdata", "statev2.sqlite"), "old-db");
      yield* fs.makeDirectory(path.join(existingTarget, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(existingTarget, "userdata", "statev2.sqlite"), "existing-db");

      const migrateConflict = yield* Effect.gen(function* () {
        const service = yield* DesktopDataDirectory.DesktopDataDirectory;
        return yield* service.migrate({ targetBaseDir: existingTarget, mode: "migrate" });
      }).pipe(Effect.provide(makeLayer({ homeDirectory: home, platform, processArch })));

      assert.strictEqual(migrateConflict.ok, false);
      assert.strictEqual(migrateConflict.targetHadExistingData, true);

      const switchResult = yield* Effect.gen(function* () {
        const service = yield* DesktopDataDirectory.DesktopDataDirectory;
        return yield* service.migrate({ targetBaseDir: existingTarget, mode: "switch" });
      }).pipe(Effect.provide(makeLayer({ homeDirectory: home, platform, processArch })));

      assert.strictEqual(switchResult.ok, true);
      assert.strictEqual(switchResult.baseDir, existingTarget);
      assert.strictEqual(switchResult.relaunching, true);
      assert.strictEqual(
        yield* fs.readFileString(path.join(existingTarget, "userdata", "statev2.sqlite")),
        "existing-db",
      );

      // Now simulate relaunched app pointing at existingTarget and reset back to default
      const resetResult = yield* Effect.gen(function* () {
        const service = yield* DesktopDataDirectory.DesktopDataDirectory;
        const state = yield* service.getState;
        assert.strictEqual(state.currentBaseDir, existingTarget);
        assert.strictEqual(state.isCustom, true);
        return yield* service.migrate({ mode: "reset" });
      }).pipe(Effect.provide(makeLayer({ homeDirectory: home, platform, processArch })));

      assert.strictEqual(resetResult.ok, true);
      assert.strictEqual(resetResult.baseDir, defaultBase);
      assert.strictEqual(resetResult.relaunching, true);
      assert.strictEqual(yield* fs.exists(path.join(home, DATA_DIRECTORY_POINTER_FILENAME)), false);
    }),
  );

  it.effect("blocks migration when T3CODE_HOME environment variable is set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const processArch = yield* HostProcess.Architecture;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "quixotic-data-dir-env-" });
      const home = path.join(root, "home");
      const envHome = path.join(root, "env-home");
      const target = path.join(root, "target");

      const { state, result } = yield* Effect.gen(function* () {
        const service = yield* DesktopDataDirectory.DesktopDataDirectory;
        const state = yield* service.getState;
        const result = yield* service.migrate({ targetBaseDir: target, mode: "migrate" });
        return { state, result };
      }).pipe(
        Effect.provide(
          makeLayer({
            homeDirectory: home,
            platform,
            processArch,
            env: { T3CODE_HOME: envHome },
          }),
        ),
      );

      assert.strictEqual(state.overriddenByEnv, true);
      assert.strictEqual(state.envOverrideValue, envHome);
      assert.strictEqual(state.currentBaseDir, envHome);
      assert.strictEqual(result.ok, false);
      assert.isDefined(result.error);
    }),
  );
});
