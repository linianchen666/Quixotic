import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@t3tools/contracts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

export function normalizeBasePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  return `${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}/`;
}

export function normalizeHttpBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }

  url.pathname = normalizeBasePathname(url.pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function joinBaseUrlPath(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl);
  const basePrefix = normalizeBasePathname(url.pathname).replace(/\/$/u, "");
  const queryStart = pathname.indexOf("?");
  const hashStart = pathname.indexOf("#");
  const splitAt =
    queryStart === -1
      ? hashStart
      : hashStart === -1
        ? queryStart
        : Math.min(queryStart, hashStart);
  const pathPart = splitAt === -1 ? pathname : pathname.slice(0, splitAt);
  const suffix = splitAt === -1 ? "" : pathname.slice(splitAt);
  const normalizedPathPart = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const fullPath = `${basePrefix}${normalizedPathPart}`;
  const next = new URL(url.origin);
  const combined = new URL(`${fullPath}${suffix}`, next.origin);
  return combined.toString();
}

export function resolveRpcSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  const trimmedPath = url.pathname.replace(/\/+$/u, "");
  if (trimmedPath === "" || trimmedPath === "/") {
    url.pathname = "/ws";
  } else if (!trimmedPath.endsWith("/ws")) {
    url.pathname = `${trimmedPath}/ws`;
  }
  return url;
}

const IP_OR_LOCALHOST_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])(?::\d+)?(?:\/|$)/iu;

/**
 * Normalizes a user-entered EasyTier node or Public Gateway address.
 * Bare IPv4/IPv6/localhost or explicit non-443 ports default to `http://`;
 * bare domain names default to `https://`.
 */
export function normalizeGatewayOrEasyTierUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a server address.");
  }
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  let candidate: string;
  if (/^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)) {
    candidate = withoutLeadingSlashes;
  } else {
    const useHttp =
      IP_OR_LOCALHOST_HOST_PATTERN.test(withoutLeadingSlashes) ||
      /^[^/?#:@]+:(?!443(?:\/|$))\d+(?:\/|$)/u.test(withoutLeadingSlashes);
    candidate = `${useHttp ? "http" : "https"}://${withoutLeadingSlashes}`;
  }
  return normalizeHttpBaseUrl(candidate);
}

export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ?? classifyHostedHttpsCompatibility(httpBaseUrl),
      desktopApp: "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
