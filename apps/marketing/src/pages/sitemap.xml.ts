import type { APIRoute } from "astro";

import { DEFAULT_LOCALE, LOCALES, LOCALIZED_PATHS, localizedHref } from "../i18n/locales";

export const GET: APIRoute = ({ site }) => {
  const entries: string[] = [];
  if (site) {
    const absolute = (path: string) => new URL(path, site).href;
    for (const path of LOCALIZED_PATHS) {
      const alternates = LOCALES.map(
        ({ code }) =>
          `<xhtml:link rel="alternate" hreflang="${code}" href="${absolute(localizedHref(code, path))}"/>`,
      );
      alternates.push(
        `<xhtml:link rel="alternate" hreflang="x-default" href="${absolute(localizedHref(DEFAULT_LOCALE, path))}"/>`,
      );
      for (const { code } of LOCALES) {
        entries.push(
          `<url><loc>${absolute(localizedHref(code, path))}</loc>${alternates.join("")}</url>`,
        );
      }
    }
    for (const path of [
      "/app",
      "/mobile",
      "/legal",
      "/privacy-policy",
      "/security-policy",
      "/terms-of-service",
    ]) {
      entries.push(`<url><loc>${absolute(path)}</loc></url>`);
    }
  }
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join("\n")}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
};
