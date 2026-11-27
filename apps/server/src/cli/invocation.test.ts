import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { posixLauncherScript } from "../cloud/pinnedRuntime.ts";
import {
  hostShellWord,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly executable?: boolean;
    readonly args?: ReadonlyArray<string>;
  }) =>
    resolveRootCliCommand("browser setup", input.args).pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  it.effect("uses the running Node and its local script under sudo", () =>
    Effect.gen(function* () {
      const cached = "/home/theo/.npm/_npx/abc/node_modules/quixotic-cli/dist/bin.mjs";
      const legacy = "/home/theo/.local/lib/node_modules/t3/dist/bin.mjs";
      for (const [node, entry] of [
        ["/usr/bin/node", cached],
        ["/home/theo/.nvm/versions/node/v24/bin/node", cached],
        ["/home/theo/.local/node/bin/node", legacy],
      ] as const) {
        expect(yield* rootCommand({ node, entry })).toBe(`sudo ${node} ${entry} browser setup`);
      }
    }),
  );

  it.effect("quotes the executable, the script and each argument for the root shell", () =>
    Effect.gen(function* () {
      expect(
        yield* rootCommand({
          node: "/opt/node js/node",
          entry: "/opt/Quixotic CLI/dist/bin.mjs",
          args: ["--base-dir", "/srv/Jane's home", ""],
        }),
      ).toBe(
        `sudo '/opt/node js/node' '/opt/Quixotic CLI/dist/bin.mjs' browser setup --base-dir '/srv/Jane'"'"'s home' ''`,
      );
    }),
  );

  it.effect("uses the desktop launcher even when PATH points to another install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "quixotic-cli");
      const otherBin = path.join(home, "bin");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.makeDirectory(otherBin);
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      yield* fs.writeFileString(path.join(otherBin, "quixotic-cli"), "#!/bin/sh\n", {
        mode: 0o755,
      });
      const desktop = {
        node: "/opt/Quixotic/quixotic",
        entry: "/opt/Quixotic/resources/app.asar/apps/server/dist/bin.mjs",
        env: { T3CODE_CLI_PATH: shim, ELECTRON_RUN_AS_NODE: "1" },
      };

      for (const searchPath of ["", otherBin, path.dirname(shim)]) {
        expect(yield* rootCommand({ ...desktop, path: searchPath })).toBe(
          `sudo '${shim}' browser setup`,
        );
      }
      yield* fs.remove(shim);
      expect(yield* rootCommand(desktop)).toBe(
        `sudo env ELECTRON_RUN_AS_NODE=1 ${desktop.node} ${desktop.entry} browser setup`,
      );
    }),
  );

  it.effect("uses the standalone executable even when an npm launcher started it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const packageDir = path.join(root, "_npx/abc/node_modules/quixotic-cli");
      const launcher = path.join(packageDir, "bin/t3.mjs");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "quixotic-cli", version: packageJson.version }),
      );

      const node = "/home/theo/.quixotic/runtime/versions/1.0.0/t3";
      for (const env of [{}, { T3CODE_NPM_LAUNCHER_PATH: launcher }]) {
        expect(
          yield* rootCommand({
            node,
            entry: node,
            executable: true,
            env,
            args: ["--base-dir", "/srv/quixotic home"],
          }),
        ).toBe(`sudo ${node} browser setup --base-dir '/srv/quixotic home'`);
      }

      expect(
        yield* resolveHostCliCommand("doctor").pipe(
          Effect.provideService(HostProcess.Arguments, [node, node]),
          Effect.provideService(HostProcess.ExecutablePath, node),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { T3CODE_NPM_LAUNCHER_PATH: launcher }),
        ),
      ).toEqual({ command: `${node} doctor`, launcher: false });
    }),
  );

  it.effect("falls back to PATH only when there is no script or launcher", () =>
    Effect.gen(function* () {
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: "" })).toBe(
        "sudo quixotic-cli browser setup",
      );
      expect(yield* rootCommand({ node: "/opt/node/bin/node", entry: "" })).toBe(
        'sudo env "PATH=$PATH" quixotic-cli browser setup',
      );
    }),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "t3.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.quixotic"]).pipe(
          Effect.provideService(HostProcess.ExecutablePath, "C:\\Program Files\\T3 Code\\t3.exe"),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\T3 Code\\t3.exe",
            "C:\\Program Files\\T3 Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { T3CODE_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.quixotic"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'quixotic-cli doctor "--base-dir" "C:\\Users\\Jane Doe\\.quixotic"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", ["--base-dir", "C:\\T3\\\u201CArchive\u201D"]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\t3.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\t3.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('quixotic-cli doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { T3CODE_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.quixotic'$/,
      );
    }),
  );

  it.effect("runs a cached script with its local Node in PowerShell", () =>
    Effect.gen(function* () {
      const node = "C:\\Program Files\\nodejs\\node.exe";
      const entry = "C:\\npm cache\\_npx\\abc\\node_modules\\quixotic-cli\\dist\\bin.mjs";
      const command = yield* resolveHostCliCommand("doctor", ["$home"]).pipe(
        Effect.provideService(HostProcess.ExecutablePath, node),
        Effect.provideService(HostProcess.Arguments, [node, entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      expect(command).toEqual({
        command: `& "${node}" "${entry}" doctor "\`$home"`,
        launcher: false,
      });
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "names the absolute path of a quixotic-cli found through a relative PATH entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bin = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(bin, "quixotic-cli"), "#!/bin/sh\n", { mode: 0o755 });
        const hostCommand = (searchPath: string) =>
          resolveHostCliCommand("doctor").pipe(
            Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
            Effect.provideService(HostProcess.Arguments, [
              "/usr/bin/node",
              "/opt/t3/lib/node_modules/t3/dist/bin.mjs",
            ]),
            Effect.provideService(HostProcess.IsExecutable, false),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.Environment, { PATH: searchPath }),
          );

        // A relative entry was searched from this process's directory, unlike the user's shell.
        expect(yield* hostCommand(path.relative(process.cwd(), bin))).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "quixotic-cli"))} doctor`,
          launcher: false,
        });
        // An empty entry makes the shell search its own directory first, wherever that is.
        expect(yield* hostCommand(`:${bin}`)).toEqual({
          command: `${hostShellWord("linux", path.join(bin, "quixotic-cli"))} doctor`,
          launcher: false,
        });
        expect(yield* hostCommand(bin)).toEqual({
          command: "quixotic-cli doctor",
          launcher: false,
        });
      }),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for script packages and the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".quixotic/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/quixotic-cli/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/quixotic-cli/bin/t3.mjs", "npx"],
        ["npm/_npx/hash/node_modules/t3/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/t3/bin/t3.mjs", "npx"],
        ["pnpm/dlx/hash/node_modules/quixotic-cli/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/quixotic-cli/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const packageRoot = path.dirname(path.dirname(entry));
        const name = path.basename(packageRoot);
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name, version: packageJson.version, bin: { [name]: "./bin/t3.mjs" } }),
        );
        const launchedBy = entry.endsWith("t3.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { T3CODE_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/quixotic-cli");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/quixotic-cli");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"quixotic-cli","version":"0.0.45","bin":{"quixotic-cli":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated t3 command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("recognizes a legacy global npm launcher only for the running version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/t3");
      const launcher = path.join(packageRoot, "bin/t3.mjs");
      const executable = path.join(root, ".quixotic/runtime/versions/1.0.0/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/t3"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { T3CODE_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, { kind: "npm-global", prefix }],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"t3","version":"${version}","bin":{"t3":"./bin/t3.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("names the launcher that started a downloaded runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      // The install script's launcher names ~/.quixotic, which here links to a home elsewhere.
      const executable = path.join(root, "data/t3/runtime/versions/1.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      const copy = path.join(root, "bin/t3-copy");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(executable, "", { mode: 0o755 });
      yield* fs.writeFileString(copy, "", { mode: 0o755 });
      yield* fs.symlink(path.join(root, "data/t3"), path.join(root, ".quixotic"));
      yield* fs.symlink(path.join(root, ".quixotic/runtime/versions/1.0.0/t3"), launcher);
      // Earlier PATH entries hold a directory and a non-executable file named t3.
      yield* fs.makeDirectory(path.join(root, "shadow-dir/t3"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "shadow-file"));
      yield* fs.writeFileString(path.join(root, "shadow-file/t3"), "");
      const resolve = (invokedAs: string, PATH = "shadow-dir:shadow-file:bin") =>
        resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.InvokedAs, invokedAs),
          Effect.provideService(HostProcess.WorkingDirectory, root),
          Effect.provideService(HostProcess.Environment, { PATH }),
          Effect.provideService(HostProcess.HomeDirectory, root),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      const baseDir = path.join(root, ".quixotic");

      expect(yield* resolve("t3")).toEqual({ kind: "t3-launcher", launcher, baseDir });
      expect(yield* resolve(launcher)).toEqual({ kind: "t3-launcher", launcher, baseDir });
      expect(yield* resolve(executable)).toBeNull();
      expect(yield* resolve(copy)).toBeNull();

      // The script launcher execs the runtime by absolute path, so argv0 names the runtime.
      yield* fs.remove(launcher);
      const script = path.join(root, "bin/quixotic-cli");
      yield* fs.writeFileString(
        script,
        posixLauncherScript(path.join(root, ".quixotic/runtime/versions/1.0.0/t3")),
        { mode: 0o755 },
      );
      expect(yield* resolve(executable, path.join(root, "bin"))).toEqual({
        kind: "t3-launcher",
        launcher: script,
        baseDir,
      });
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/t3/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".quixotic/runtime/0.0.45/t3",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
