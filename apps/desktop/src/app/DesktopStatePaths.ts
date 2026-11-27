import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export const desktopStateDatabase = (baseDir: string, joinPath: JoinPath) =>
  joinPath(baseDir, "userdata", "statev2.sqlite");

export function resolveDefaultDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly hasState?: (path: string) => boolean;
}): string {
  const current = input.joinPath(input.homeDirectory, ".quixotic");
  const legacy = input.joinPath(input.homeDirectory, ".t3");
  return input.hasState &&
    !input.hasState(desktopStateDatabase(current, input.joinPath)) &&
    input.hasState(desktopStateDatabase(legacy, input.joinPath))
    ? legacy
    : current;
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly configuredBaseDir?: Option.Option<string>;
  readonly hasState?: (path: string) => boolean;
}): string {
  const envConfigured = normalizeConfiguredBaseDir(input.t3Home);
  if (Option.isSome(envConfigured)) return envConfigured.value;
  if (input.configuredBaseDir) {
    const pointerConfigured = normalizeConfiguredBaseDir(input.configuredBaseDir);
    if (Option.isSome(pointerConfigured)) return pointerConfigured.value;
  }
  return resolveDefaultDesktopBaseDir(input);
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
