import type { APIRoute } from "astro";

import { REPOSITORY_URL } from "../../lib/site";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const GET: APIRoute = ({ site }) => {
  const body = [
    `Contact: ${REPOSITORY_URL}/security/advisories/new`,
    `Policy: ${site ? new URL("/security-policy", site) : REPOSITORY_URL + "/blob/main/.github/SECURITY.md"}`,
    ...(site ? [`Canonical: ${new URL("/.well-known/security.txt", site)}`] : []),
    "Preferred-Languages: en",
    `Expires: ${new Date(Date.now() + ONE_YEAR_MS).toISOString()}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
