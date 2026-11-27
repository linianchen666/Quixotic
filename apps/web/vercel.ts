import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const router = process.env.VITE_HOSTED_APP_CHANNEL_ROUTER?.trim();
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const latestOrigin = process.env.QUIXOTIC_WEB_LATEST_ORIGIN?.trim();
const nightlyOrigin = process.env.QUIXOTIC_WEB_NIGHTLY_ORIGIN?.trim();
const routerHost = router && latestOrigin && nightlyOrigin ? new URL(router).host : null;
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: routerHost ? [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(routerHost), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${nightlyOrigin}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(routerHost)],
      dest: `${latestOrigin}/$1`,
    },
  ] : [],
  rewrites: [
    // Apple fetches it without an extension; the .json file is served as application/json.
    routes.rewrite(
      "/.well-known/apple-app-site-association",
      "/.well-known/apple-app-site-association.json",
    ),
    routes.rewrite("/(.*)", "/index.html"),
  ],
};
