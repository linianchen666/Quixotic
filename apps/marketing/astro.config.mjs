import { defineConfig } from "astro/config";
import { LOCALES } from "./src/i18n/locales.ts";

delete process.env.VP_RUN_NODE_CLIENT_PATH;

export default defineConfig({
  site: process.env.QUIXOTIC_MARKETING_SITE_URL,
  i18n: {
    defaultLocale: "en",
    locales: LOCALES.map(({ code, path }) =>
      !path || path === code ? code : { path, codes: [code] },
    ),
    routing: { prefixDefaultLocale: false },
  },
  trailingSlash: "never",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
