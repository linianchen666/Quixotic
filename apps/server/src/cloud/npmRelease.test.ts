import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as NpmRelease from "./npmRelease.ts";

it.layer(NpmRelease.layer)("npm release lookup", (it) => {
  it.effect.each(["latest", "nightly", "0.1.5", "0.1.5-nightly.20261030.1"])(
    "returns no release for %s without a registry or process runner",
    (spec) =>
      Effect.gen(function* () {
        const releases = yield* NpmRelease.NpmRelease;
        expect(yield* releases.get({ spec })).toBeNull();
      }),
  );

  it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
    "rejects an invalid release spec (%s)",
    (spec) =>
      Effect.gen(function* () {
        const releases = yield* NpmRelease.NpmRelease;
        const error = yield* Effect.flip(releases.get({ spec }));
        expect(error).toBeInstanceOf(ServerNpmReleaseError);
        expect(error.reason).toBe("Invalid release version or track.");
      }),
  );
});
