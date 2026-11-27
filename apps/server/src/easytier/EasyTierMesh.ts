// @effect-diagnostics nodeBuiltinImport:off -- Performs direct TCP reachability pre-checks and reads local OS network interfaces for EasyTier mesh discovery.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  AuthAccessTokenResult,
  EASYTIER_MESH_PROXY_PREFIX,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type EasyTierMeshPeer,
  type EasyTierMeshStatus,
} from "@t3tools/contracts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import {
  formatHostForUrl,
  isBenchmarkOrProxyTunIpv4,
  isEasyTierInterfaceName,
  isIpv4InCidr,
  isLocalLoopbackHost,
  isRfc1918Ipv4,
  isSharedAddressSpaceHost,
  normalizeIpv4Address,
  parseIpv4Cidr,
  uint32ToIpv4,
} from "@t3tools/shared/hostClassification";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpServer, HttpServerRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isVirtualInterface } from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

const SCAN_INTERVAL = Duration.seconds(15);
const TCP_PROBE_TIMEOUT_MS = 400;
const DESCRIPTOR_PROBE_TIMEOUT_MS = 2_000;
const EASYTIER_CLI_TIMEOUT = Duration.seconds(2);
const PEER_TOKEN_REFRESH_SKEW_MS = 60_000;
const TCP_PROBE_CONCURRENCY = 64;

const PROXY_FORWARDING_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

export interface LocalEasyTierInterfaceInfo {
  readonly localIp: string | null;
  readonly cidr: string | null;
  readonly interfaceName: string | null;
}

export interface EasyTierCliPeerInfo {
  readonly ipv4: string;
  readonly hostname?: string;
  readonly latencyMs?: number;
}

interface ProbeCandidate {
  readonly ip: string;
  readonly port: number;
  readonly hostname?: string;
  readonly latencyMs?: number;
  readonly skipTcpPrecheck?: boolean;
}

interface CachedPeerToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);
const decodeAccessTokenResult = Schema.decodeUnknownEffect(AuthAccessTokenResult);

export function hasProxyForwardingHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): boolean {
  return PROXY_FORWARDING_HEADERS.some((header) => {
    const value = headers[header];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function extractSocketRemoteIpv4(
  request: Pick<HttpServerRequest.HttpServerRequest, "source">,
): string | null {
  const source = request.source;
  if (!source || typeof source !== "object") return null;
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  const raw = candidate.socket?.remoteAddress ?? candidate.remoteAddress;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return normalizeIpv4Address(raw.trim());
}

/**
 * Returns true ONLY when the HTTP/WS request arrived directly over TCP from an IP
 * inside the local EasyTier mesh CIDR and carries NO reverse-proxy forwarding headers.
 * This prevents an external reverse proxy on a gateway node from spoofing mesh trust.
 */
export function isDirectEasyTierRequest(
  request: Pick<HttpServerRequest.HttpServerRequest, "headers" | "source">,
  meshCidr: string | null,
): boolean {
  if (!meshCidr) return false;
  if (hasProxyForwardingHeaders(request.headers)) return false;
  const remoteIp = extractSocketRemoteIpv4(request);
  if (remoteIp === null) return false;
  return isIpv4InCidr(remoteIp, meshCidr);
}

/**
 * Returns true when the caller appears to be reaching this server from outside
 * the EasyTier mesh and outside loopback (e.g., mobile phone over public IP/4G/Wi-Fi).
 */
export function isRequestFromOutsideMesh(
  request: Pick<HttpServerRequest.HttpServerRequest, "headers" | "source">,
  meshCidr: string | null,
  gatewayMode: boolean,
): boolean {
  if (hasProxyForwardingHeaders(request.headers)) return true;
  const remoteIp = extractSocketRemoteIpv4(request);
  if (remoteIp === null) return gatewayMode;
  if (isLocalLoopbackHost(remoteIp)) return false;
  if (meshCidr && isIpv4InCidr(remoteIp, meshCidr)) return false;
  return true;
}

const NON_EASYTIER_TUN_INTERFACE =
  /(?:clash|mihomo|flclash|verge|sing-?box|v2ray|xray|shadowsocks|tailscale|wireguard|zerotier|openvpn|nord|mullvad|warp|cloudflare|meta)/i;

const ZERO_MAC_ADDRESS = "00:00:00:00:00:00";

function isValidEasyTierIpv4(ip: string): boolean {
  return (
    !ip.startsWith("127.") &&
    !ip.startsWith("169.254.") &&
    !isBenchmarkOrProxyTunIpv4(ip) &&
    !isSharedAddressSpaceHost(ip) &&
    isRfc1918Ipv4(ip)
  );
}

/**
 * Detects the active local EasyTier virtual interface and CIDR.
 * Explicitly excludes loopback, link-local, Clash/Mihomo 198.18.0.0/15, Tailscale 100.64.0.0/10,
 * and container/VM bridges.
 */
export function detectLocalEasyTierInterface(
  interfaces: NetworkInterfacesMap,
  platform: NodeJS.Platform,
  overrideCidr?: string,
): LocalEasyTierInterfaceInfo {
  const parsedOverride = overrideCidr ? parseIpv4Cidr(overrideCidr) : null;
  const entries = Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? []).map((entry) => ({ name, entry })),
  );

  if (parsedOverride !== null) {
    const matching = entries.find(
      ({ entry }) =>
        entry.family === "IPv4" && isIpv4InCidr(entry.address, parsedOverride.cidr),
    );
    return {
      localIp: matching?.entry.address ?? null,
      cidr: parsedOverride.cidr,
      interfaceName: matching?.name ?? null,
    };
  }

  // Pass 1: Explicit EasyTier / TUN interface names (tun*, utun*, easytier*, et_*, et0, wintun*).
  for (const { name, entry } of entries) {
    if (entry.internal || entry.family !== "IPv4") continue;
    if (isVirtualInterface(name, platform)) continue;
    if (!isEasyTierInterfaceName(name)) continue;
    if (!isValidEasyTierIpv4(entry.address)) continue;
    const parsedCidr = entry.cidr
      ? parseIpv4Cidr(entry.cidr)
      : parseIpv4Cidr(`${entry.address}/24`);
    if (parsedCidr === null) continue;
    return {
      localIp: entry.address,
      cidr: parsedCidr.cidr,
      interfaceName: name,
    };
  }

  // Pass 2 (Windows fallback): Wintun Layer-3 TUN adapters on Windows report an all-zero MAC
  // even when localized or renamed (e.g. "本地连接* 12"). Prefer 10.0.0.0/8 (EasyTier's default).
  if (platform === "win32") {
    const zeroMacCandidates = entries.filter(
      ({ name, entry }) =>
        !entry.internal &&
        entry.family === "IPv4" &&
        entry.mac === ZERO_MAC_ADDRESS &&
        !isVirtualInterface(name, platform) &&
        !NON_EASYTIER_TUN_INTERFACE.test(name) &&
        isValidEasyTierIpv4(entry.address),
    );
    const chosen =
      zeroMacCandidates.find(({ entry }) => entry.address.startsWith("10.")) ??
      zeroMacCandidates[0];
    if (chosen) {
      const parsedCidr = chosen.entry.cidr
        ? parseIpv4Cidr(chosen.entry.cidr)
        : parseIpv4Cidr(`${chosen.entry.address}/24`);
      if (parsedCidr !== null) {
        return {
          localIp: chosen.entry.address,
          cidr: parsedCidr.cidr,
          interfaceName: chosen.name,
        };
      }
    }
  }

  return { localIp: null, cidr: null, interfaceName: null };
}

export function parseEasyTierCliPeersJson(stdout: string): ReadonlyArray<EasyTierCliPeerInfo> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const peers: EasyTierCliPeerInfo[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawIpv4 = typeof record.ipv4 === "string" ? record.ipv4.trim() : "";
    const ipOnly = rawIpv4.split("/", 1)[0]?.trim() ?? "";
    const ip = normalizeIpv4Address(ipOnly);
    if (ip === null || isLocalLoopbackHost(ip) || isBenchmarkOrProxyTunIpv4(ip)) continue;
    const cost = typeof record.cost === "string" ? record.cost.trim().toLowerCase() : "";
    if (cost === "local") continue;
    const hostname =
      typeof record.hostname === "string" && record.hostname.trim().length > 0
        ? record.hostname.trim()
        : undefined;
    const rawLat =
      typeof record.lat_ms === "number"
        ? record.lat_ms
        : typeof record.lat_ms === "string"
          ? Number.parseFloat(record.lat_ms)
          : Number.NaN;
    const latencyMs = Number.isFinite(rawLat) && rawLat >= 0 ? rawLat : undefined;
    peers.push({
      ipv4: ip,
      ...(hostname === undefined ? {} : { hostname }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
    });
  }
  return peers;
}

export function parseStaticEasyTierPeerSpec(
  raw: string,
  defaultPort: number,
): { readonly ip: string; readonly port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/^https?:\/\//iu, "").replace(/\/.*$/u, "");
  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex > 0) {
    const ipPart = cleaned.slice(0, colonIndex).trim();
    const portPart = Number.parseInt(cleaned.slice(colonIndex + 1).trim(), 10);
    const ip = normalizeIpv4Address(ipPart);
    if (
      ip !== null &&
      !isBenchmarkOrProxyTunIpv4(ip) &&
      Number.isInteger(portPart) &&
      portPart >= 1 &&
      portPart <= 65535
    ) {
      return { ip, port: portPart };
    }
    return null;
  }
  const ip = normalizeIpv4Address(cleaned);
  return ip === null || isBenchmarkOrProxyTunIpv4(ip) ? null : { ip, port: defaultPort };
}

export function enumerateSubnetHosts(cidr: string, excludeIp: string | null): ReadonlyArray<string> {
  const parsed = parseIpv4Cidr(cidr);
  if (parsed === null || parsed.prefixLength < 24 || parsed.prefixLength > 30) {
    return [];
  }
  const hostCount = 1 << (32 - parsed.prefixLength);
  const hosts: string[] = [];
  for (let offset = 1; offset < hostCount - 1; offset += 1) {
    const ip = uint32ToIpv4((parsed.network + offset) >>> 0);
    if (ip !== excludeIp) {
      hosts.push(ip);
    }
  }
  return hosts;
}

function tcpPortReachable(host: string, port: number, timeoutMs: number): Effect.Effect<boolean> {
  return Effect.callback<boolean>((resume) => {
    const socket = NodeNet.connect({ host, port });
    socket.setTimeout(timeoutMs);
    let settled = false;
    const settle = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(open));
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    return Effect.sync(() => {
      socket.destroy();
    });
  });
}

function buildGatewayPeerUrls(
  gatewayOrigin: string,
  environmentId: EnvironmentId,
): { readonly gatewayHttpBaseUrl: string; readonly gatewayWsBaseUrl: string } {
  const base = normalizeHttpBaseUrl(
    `${gatewayOrigin.replace(/\/+$/u, "")}${EASYTIER_MESH_PROXY_PREFIX}/${encodeURIComponent(environmentId)}/`,
  );
  return {
    gatewayHttpBaseUrl: base,
    gatewayWsBaseUrl: deriveWsBaseUrl(base),
  };
}

export class EasyTierMesh extends Context.Service<
  EasyTierMesh,
  {
    readonly getLocalInfo: () => LocalEasyTierInterfaceInfo;
    readonly isDirectEasyTierRequest: (
      request: Pick<HttpServerRequest.HttpServerRequest, "headers" | "source">,
    ) => boolean;
    readonly getStatusForRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<EasyTierMeshStatus>;
    readonly refresh: () => Effect.Effect<ReadonlyArray<EasyTierMeshPeer>>;
    readonly getPeer: (environmentId: EnvironmentId) => Effect.Effect<Option.Option<EasyTierMeshPeer>>;
    readonly getPeerBearerToken: (
      environmentId: EnvironmentId,
      options?: { readonly forceRefresh?: boolean },
    ) => Effect.Effect<Option.Option<string>>;
  }
>()("quixotic-cli/easytier/EasyTierMesh") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const httpClient = yield* HttpClient.HttpClient;
  const spawnerOpt = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const httpServerOpt = yield* Effect.serviceOption(HttpServer.HttpServer);
  const settingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const ownDescriptor = yield* serverEnvironment.getDescriptor;
  const peersRef = yield* Ref.make<ReadonlyArray<EasyTierMeshPeer>>([]);
  const lastScannedAtRef = yield* Ref.make<DateTime.Utc | null>(null);
  const peerTokenCache = new Map<EnvironmentId, CachedPeerToken>();
  const scanPermit = yield* Semaphore.make(1);
  const peerTokenPermit = yield* Semaphore.make(1);

  const enabled = config.easyTierEnabled !== false;

  const currentPort = (): number => {
    if (Option.isSome(httpServerOpt)) {
      const address = httpServerOpt.value.address;
      if (typeof address === "object" && address !== null && "port" in address) {
        return address.port;
      }
    }
    return config.port;
  };

  const getLocalInfo = (): LocalEasyTierInterfaceInfo => {
    if (!enabled) {
      return { localIp: null, cidr: null, interfaceName: null };
    }
    return detectLocalEasyTierInterface(
      NodeOS.networkInterfaces(),
      platform,
      config.easyTierCidr,
    );
  };

  const readCliPeers = Effect.gen(function* () {
    if (Option.isNone(spawnerOpt)) return [] as ReadonlyArray<EasyTierCliPeerInfo>;
    const command = ChildProcess.make("easytier-cli", ["-o", "json", "peer"]);
    const stdout = yield* spawnerOpt.value.string(command).pipe(
      Effect.timeoutOption(EASYTIER_CLI_TIMEOUT),
      Effect.map(Option.getOrElse(() => "")),
      Effect.orElseSucceed(() => ""),
    );
    return stdout.length > 0 ? parseEasyTierCliPeersJson(stdout) : [];
  });

  const probePeerDescriptor = Effect.fn("EasyTierMesh.probePeerDescriptor")(function* (
    candidate: ProbeCandidate,
  ) {
    if (!candidate.skipTcpPrecheck) {
      const reachable = yield* tcpPortReachable(
        candidate.ip,
        candidate.port,
        TCP_PROBE_TIMEOUT_MS,
      );
      if (!reachable) return null;
    }
    const httpBaseUrl = normalizeHttpBaseUrl(
      `http://${formatHostForUrl(candidate.ip)}:${candidate.port}/`,
    );
    const descriptorUrl = `${httpBaseUrl}.well-known/t3/environment`;
    const startedAt = yield* Clock.currentTimeMillis;
    const response = yield* httpClient
      .execute(HttpClientRequest.get(descriptorUrl))
      .pipe(
        Effect.flatMap((res) => (res.status === 200 ? res.json : Effect.succeed(null))),
        Effect.flatMap((json) =>
          json === null
            ? Effect.succeed(null)
            : decodeDescriptor(json).pipe(Effect.orElseSucceed(() => null)),
        ),
        Effect.timeoutOption(Duration.millis(DESCRIPTOR_PROBE_TIMEOUT_MS)),
        Effect.map(Option.getOrElse(() => null)),
        Effect.orElseSucceed(() => null),
      );
    if (response === null || response.environmentId === ownDescriptor.environmentId) {
      return null;
    }
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    const now = DateTime.toUtc(yield* DateTime.now);
    return {
      environmentId: response.environmentId,
      label: response.label,
      platform: response.platform,
      serverVersion: response.serverVersion,
      ...(response.orchestrationProtocolVersion === undefined
        ? {}
        : { orchestrationProtocolVersion: response.orchestrationProtocolVersion }),
      easyTierIp: candidate.ip,
      port: candidate.port,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      ...(candidate.hostname === undefined ? {} : { hostname: candidate.hostname }),
      latencyMs: candidate.latencyMs ?? elapsedMs,
      online: true,
      lastSeenAt: now,
    } satisfies EasyTierMeshPeer;
  });

  const runScan = Effect.fn("EasyTierMesh.scan")(function* () {
    if (!enabled) {
      yield* Ref.set(peersRef, []);
      return [] as ReadonlyArray<EasyTierMeshPeer>;
    }
    const localInfo = getLocalInfo();
    const listeningPort = currentPort();
    const probePorts = [
      ...new Set(
        (config.easyTierPorts && config.easyTierPorts.length > 0
          ? config.easyTierPorts
          : [ServerConfig.DEFAULT_PORT, ...(listeningPort > 0 ? [listeningPort] : [])]
        ).filter((port) => port > 0 && port <= 65535),
      ),
    ];

    const candidateMap = new Map<string, ProbeCandidate>();
    const addCandidate = (candidate: ProbeCandidate) => {
      const key = `${candidate.ip}:${candidate.port}`;
      const existing = candidateMap.get(key);
      if (!existing) {
        candidateMap.set(key, candidate);
      } else {
        candidateMap.set(key, {
          ...existing,
          ...(candidate.hostname !== undefined ? { hostname: candidate.hostname } : {}),
          ...(candidate.latencyMs !== undefined ? { latencyMs: candidate.latencyMs } : {}),
          ...(existing.skipTcpPrecheck || candidate.skipTcpPrecheck
            ? { skipTcpPrecheck: true }
            : {}),
        });
      }
    };

    // 1. Explicit configured static peers (including custom ports for multi-node tests)
    for (const rawSpec of config.easyTierPeers ?? []) {
      const parsed = parseStaticEasyTierPeerSpec(rawSpec, ServerConfig.DEFAULT_PORT);
      if (parsed) {
        addCandidate({ ip: parsed.ip, port: parsed.port, skipTcpPrecheck: true });
      }
    }

    // 2. Peers reported by easytier-cli (if installed locally)
    const cliPeers = yield* readCliPeers;
    for (const cliPeer of cliPeers) {
      if (cliPeer.ipv4 === localInfo.localIp) continue;
      for (const port of probePorts) {
        addCandidate({
          ip: cliPeer.ipv4,
          port,
          ...(cliPeer.hostname === undefined ? {} : { hostname: cliPeer.hostname }),
          ...(cliPeer.latencyMs === undefined ? {} : { latencyMs: cliPeer.latencyMs }),
        });
      }
    }

    // 3. Previously seen peers (fast re-verification)
    const previousPeers = yield* Ref.get(peersRef);
    for (const peer of previousPeers) {
      addCandidate({
        ip: peer.easyTierIp,
        port: peer.port,
        ...(peer.hostname === undefined ? {} : { hostname: peer.hostname }),
      });
    }

    // 4. Full subnet /24 sweep when local EasyTier CIDR is active (zero CLI dependency!)
    if (localInfo.cidr && !config.easyTierPeers?.length) {
      const subnetHosts = enumerateSubnetHosts(localInfo.cidr, localInfo.localIp);
      for (const ip of subnetHosts) {
        for (const port of probePorts) {
          addCandidate({ ip, port });
        }
      }
    }

    const candidates = [...candidateMap.values()];
    const discovered = yield* Effect.forEach(candidates, probePeerDescriptor, {
      concurrency: TCP_PROBE_CONCURRENCY,
    });

    const byEnvironmentId = new Map<EnvironmentId, EasyTierMeshPeer>();
    for (const peer of discovered) {
      if (peer === null) continue;
      const existing = byEnvironmentId.get(peer.environmentId);
      if (!existing || (peer.latencyMs ?? Infinity) < (existing.latencyMs ?? Infinity)) {
        byEnvironmentId.set(peer.environmentId, peer);
      }
    }

    const sortedPeers = [...byEnvironmentId.values()].toSorted((a, b) =>
      a.label.localeCompare(b.label),
    );
    const scannedAt = DateTime.toUtc(yield* DateTime.now);
    yield* Ref.set(peersRef, sortedPeers);
    yield* Ref.set(lastScannedAtRef, scannedAt);
    return sortedPeers;
  });

  const refresh = () => scanPermit.withPermit(runScan());

  const resolveConfiguredPublicGatewayUrl = Effect.gen(function* () {
    if (config.publicGatewayUrl) {
      return config.publicGatewayUrl;
    }
    if (Option.isSome(settingsOpt)) {
      const settings = yield* settingsOpt.value.getSettings.pipe(
        Effect.orElseSucceed(() => null),
      );
      const saved = settings?.publicPairingAddress?.trim() ?? "";
      if (saved.length > 0) return saved;
    }
    return null;
  });

  const getStatusForRequest: EasyTierMesh["Service"]["getStatusForRequest"] = Effect.fn(
    "EasyTierMesh.getStatusForRequest",
  )(function* (request) {
    const localInfo = getLocalInfo();
    const peers = yield* Ref.get(peersRef);
    const lastScannedAt = yield* Ref.get(lastScannedAtRef);
    const gatewayPasswordConfigured = yield* serverAuth.isGatewayPasswordConfigured();
    const gatewayMode = config.gatewayMode === true || gatewayPasswordConfigured;
    const preferGatewayProxy = isRequestFromOutsideMesh(request, localInfo.cidr, gatewayMode);
    const reqUrl = requestUrl(request);
    const configuredPublicGatewayUrl = yield* resolveConfiguredPublicGatewayUrl;
    const proxyOrigin = Option.isSome(reqUrl)
      ? reqUrl.value.origin
      : configuredPublicGatewayUrl;

    const enrichedPeers = peers.map((peer): EasyTierMeshPeer => {
      if (!proxyOrigin) return peer;
      const proxyUrls = buildGatewayPeerUrls(proxyOrigin, peer.environmentId);
      return {
        ...peer,
        ...proxyUrls,
      };
    });

    return {
      enabled,
      active: enabled && (localInfo.cidr !== null || enrichedPeers.length > 0),
      localEnvironmentId: ownDescriptor.environmentId,
      localLabel: ownDescriptor.label,
      localIp: localInfo.localIp,
      cidr: localInfo.cidr,
      interfaceName: localInfo.interfaceName,
      port: currentPort(),
      gatewayMode,
      gatewayPasswordConfigured,
      publicGatewayUrl:
        configuredPublicGatewayUrl ?? (preferGatewayProxy && proxyOrigin ? proxyOrigin : null),
      preferGatewayProxy,
      peers: enrichedPeers,
      lastScannedAt,
    } satisfies EasyTierMeshStatus;
  });

  const getPeer: EasyTierMesh["Service"]["getPeer"] = (environmentId) =>
    Ref.get(peersRef).pipe(
      Effect.map((peers) => Option.fromNullishOr(peers.find((p) => p.environmentId === environmentId))),
    );

  const getPeerBearerToken: EasyTierMesh["Service"]["getPeerBearerToken"] = (
    environmentId,
    options,
  ) =>
    peerTokenPermit.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = peerTokenCache.get(environmentId);
        if (
          !options?.forceRefresh &&
          cached !== undefined &&
          cached.expiresAtMs - PEER_TOKEN_REFRESH_SKEW_MS > now
        ) {
          return Option.some(cached.accessToken);
        }
        const peerOpt = yield* getPeer(environmentId);
        if (Option.isNone(peerOpt)) {
          peerTokenCache.delete(environmentId);
          return Option.none<string>();
        }
        const peer = peerOpt.value;
        const sessionUrl = `${peer.httpBaseUrl}api/easytier/mesh-session`;
        const req = HttpClientRequest.post(sessionUrl).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            clientLabel: `${ownDescriptor.label} (EasyTier Gateway)`,
            clientDeviceType: "desktop",
            clientOs: platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux",
          }),
        );
        const tokenResult = yield* httpClient.execute(req).pipe(
          Effect.flatMap((res) => (res.status === 200 ? res.json : Effect.succeed(null))),
          Effect.flatMap((json) =>
            json === null
              ? Effect.succeed(null)
              : decodeAccessTokenResult(json).pipe(Effect.orElseSucceed(() => null)),
          ),
          Effect.timeoutOption(Duration.seconds(5)),
          Effect.map(Option.getOrElse(() => null)),
          Effect.orElseSucceed(() => null),
        );
        if (tokenResult === null) {
          peerTokenCache.delete(environmentId);
          return Option.none<string>();
        }
        peerTokenCache.set(environmentId, {
          accessToken: tokenResult.access_token,
          expiresAtMs: now + tokenResult.expires_in * 1000,
        });
        return Option.some(tokenResult.access_token);
      }),
    );

  // Background EasyTier mesh discovery fiber (only when enabled)
  if (enabled) {
    yield* Effect.gen(function* () {
      yield* refresh().pipe(Effect.ignore);
      return yield* Effect.sleep(SCAN_INTERVAL).pipe(
        Effect.andThen(refresh().pipe(Effect.ignore)),
        Effect.forever,
      );
    }).pipe(Effect.forkScoped);
  }

  return EasyTierMesh.of({
    getLocalInfo,
    isDirectEasyTierRequest: (request) => isDirectEasyTierRequest(request, getLocalInfo().cidr),
    getStatusForRequest,
    refresh,
    getPeer,
    getPeerBearerToken,
  });
});

export const layer = Layer.effect(EasyTierMesh, make);
