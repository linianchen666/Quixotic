import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.quixotic.app"],
  ["development", "com.quixotic.app.dev"],
  ["preview", "com.quixotic.app.preview"],
  ["production", "com.quixotic.app"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.name).toMatch(/^Quixotic/);
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.ios?.appleTeamId).toBeUndefined();
  // A fork can coexist with the upstream app without claiming its system deep links.
  expect(config.scheme).not.toContain("t3code");
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.scheme).toBe(
    value === "development"
      ? "quixotic-dev"
      : value === "preview"
        ? "quixotic-preview"
        : "quixotic",
  );
  expect(appleAppSiteAssociation.applinks.details).toEqual([]);
  expect(assetLinks).toEqual([]);
});
