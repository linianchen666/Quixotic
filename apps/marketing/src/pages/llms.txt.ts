import type { APIRoute } from "astro";

import { INSTALL_GUIDE_URL, REPOSITORY_URL, RELEASES_URL } from "../lib/site";

export const GET: APIRoute = () =>
  new Response(
    `# Quixotic

> Quixotic runs coding agents on the owner's machine and offers desktop, web, and mobile clients.

- [Source code](${REPOSITORY_URL})
- [Installation guide](${INSTALL_GUIDE_URL})
- [GitHub Releases](${RELEASES_URL})
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
