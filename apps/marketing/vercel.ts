import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  trailingSlash: false,
  headers: [
    {
      source: "/install.sh",
      headers: [{ key: "Content-Type", value: "text/x-shellscript; charset=utf-8" }],
    },
    {
      source: "/install.ps1",
      headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
    },
  ],
};
