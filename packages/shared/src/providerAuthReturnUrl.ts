import { LEGACY_HOSTED_APP_ORIGIN } from "./connectAuth.ts";
import { isLoopbackHost } from "./preview.ts";

export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppOrigin?: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["quixotic:", "quixotic-dev:"].includes(url.protocol) && url.host === "app";
    const trustedOrigin = hostedAppOrigin ? new URL(hostedAppOrigin) : undefined;
    const hosted =
      trustedOrigin?.protocol === "https:" &&
      !trustedOrigin.username &&
      !trustedOrigin.password &&
      trustedOrigin.pathname === "/" &&
      !trustedOrigin.search &&
      !trustedOrigin.hash &&
      trustedOrigin.origin !== LEGACY_HOSTED_APP_ORIGIN &&
      url.origin === trustedOrigin.origin;
    const web =
      ["http:", "https:"].includes(url.protocol) && (isLoopbackHost(url.hostname) || hosted);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
