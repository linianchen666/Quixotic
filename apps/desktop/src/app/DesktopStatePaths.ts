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

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly hasState?: (path: string) => boolean;
}): string {
  const configured = normalizeConfiguredBaseDir(input.t3Home);
  if (Option.isSome(configured)) return configured.value;
  const current = input.joinPath(input.homeDirectory, ".quixotic");
  const legacy = input.joinPath(input.homeDirectory, ".t3");
  return input.hasState &&
    !input.hasState(desktopStateDatabase(current, input.joinPath)) &&
    input.hasState(desktopStateDatabase(legacy, input.joinPath))
    ? legacy
    : current;
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
