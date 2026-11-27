import type { ServerDirectEndpoint } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  formatHostForUrl,
  isBenchmarkOrProxyTunIpv4,
  isEasyTierInterfaceName,
  isRfc1918Ipv4,
  isSharedAddressSpaceHost,
  isWildcardHost,
} from "@t3tools/shared/hostClassification";

import * as ServerConfig from "../config.ts";
import {
  isLoopbackHost,
  isPrivateNetworkAddress,
  isVirtualInterface,
  WINDOWS_HOST_ADAPTER_MAC,
} from "../startupAccess.ts";

type NetworkInterfacesMap = ReturnType<typeof NodeOS.networkInterfaces>;

export class DirectEndpoints extends Context.Service<
  DirectEndpoints,
  {
    readonly resolveAvailable: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
    readonly resolve: () => Effect.Effect<ReadonlyArray<ServerDirectEndpoint>>;
  }
>()("quixotic-cli/environment/DirectEndpoints") {}

// Exclude loopback, link-local, Clash/Mihomo fake-IP TUN (198.18.0.0/15), and legacy Tailscale/CGNAT (100.64.0.0/10).
const isAdvertisableAddress = (address: string): boolean =>
  NodeNet.isIPv4(address) &&
  !address.startsWith("127.") &&
  !isBenchmarkOrProxyTunIpv4(address) &&
  !isSharedAddressSpaceHost(address) &&
  isPrivateNetworkAddress(address);

export function resolveBoundEndpoints(input: {
  readonly platform: NodeJS.Platform;
  readonly host: string | undefined;
  readonly port: number;
  readonly interfaces: NetworkInterfacesMap;
  /** A cloud VM's private network is its provider's, which no client shares — keep EasyTier only. */
  readonly onCloudVm?: boolean;
  readonly isolatedBridges?: ReadonlySet<string>;
}): ReadonlyArray<ServerDirectEndpoint> {
  if (isLoopbackHost(input.host)) return [];
  const easyTierAddresses = new Set(
    Object.entries(input.interfaces).flatMap(([name, entries = []]) =>
      isEasyTierInterfaceName(name)
        ? entries
            .filter(
              (entry) =>
                !entry.internal &&
                entry.family === "IPv4" &&
                isRfc1918Ipv4(entry.address) &&
                !isBenchmarkOrProxyTunIpv4(entry.address),
            )
            .map((entry) => entry.address)
        : [],
    ),
  );
  const addresses = isWildcardHost(input.host)
    ? Object.entries(input.interfaces)
        .flatMap(([name, entries]) =>
          isVirtualInterface(name, input.platform) || input.isolatedBridges?.has(name)
            ? []
            : (entries ?? []),
        )
        .filter(
          (entry) =>
            !entry.internal &&
            entry.family === "IPv4" &&
            isAdvertisableAddress(entry.address) &&
            !(input.platform === "win32" && WINDOWS_HOST_ADAPTER_MAC.test(entry.mac)),
        )
        .map((entry) => entry.address)
    : [input.host!].filter((address) => isAdvertisableAddress(address));

  // Prioritize EasyTier mesh endpoints first so clients always prefer EasyTier over raw LAN.
  const unique = [...new Set(addresses)]
    .filter((address) => !input.onCloudVm || easyTierAddresses.has(address))
    .toSorted((left, right) => {
      const leftEt = easyTierAddresses.has(left) ? 0 : 1;
      const rightEt = easyTierAddresses.has(right) ? 0 : 1;
      return leftEt - rightEt;
    });

  return unique.map((address) => ({
    kind: easyTierAddresses.has(address) ? "easytier" : "lan",
    httpBaseUrl: `http://${formatHostForUrl(address)}:${input.port}/`,
  }));
}

const SYSFS_NET = "/sys/class/net";

/**
 * Linux bridges with no port leading to a NIC, such as a container network
 * under any name. A host bridge like `br0` enslaves the NIC, directly or
 * through a bond or VLAN, and stays listed.
 */
export const readIsolatedLinuxBridges = Effect.fn("DirectEndpoints.readIsolatedLinuxBridges")(
  function* (names: ReadonlyArray<string>, root = SYSFS_NET) {
    const fs = yield* FileSystem.FileSystem;
    const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    const list = (path: string) =>
      fs.readDirectory(path).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const reachesHardware: (name: string, depth: number) => Effect.Effect<boolean> =
      Effect.fnUntraced(function* (name: string, depth: number) {
        if (yield* exists(`${root}/${name}/device`)) return true;
        if (depth === 0) return false;
        const lowers = (yield* list(`${root}/${name}`)).flatMap((entry) =>
          entry.startsWith("lower_") ? [entry.slice("lower_".length)] : [],
        );
        for (const lower of lowers) {
          if (yield* reachesHardware(lower, depth - 1)) return true;
        }
        return false;
      });
    const isolated = new Set<string>();
    for (const name of names) {
      if (!(yield* exists(`${root}/${name}/bridge`))) continue;
      let uplinked = false;
      for (const port of yield* list(`${root}/${name}/brif`)) {
        if (yield* reachesHardware(port, 3)) {
          uplinked = true;
          break;
        }
      }
      if (!uplinked) isolated.add(name);
    }
    return isolated;
  },
);

/**
 * AWS, GCP, Azure, DigitalOcean, Hetzner, Linode, Vultr, and Oracle all serve
 * instance metadata at this address. A plain TCP connect skips HTTP proxies,
 * which would otherwise answer for a machine that is not in a cloud.
 */
const CLOUD_METADATA_ADDRESS = "169.254.169.254";
const CLOUD_METADATA_TIMEOUT_MS = 300;

const probeCloudMetadata = Effect.callback<boolean>((resume) => {
  const socket = NodeNet.connect({
    host: CLOUD_METADATA_ADDRESS,
    port: 80,
    timeout: CLOUD_METADATA_TIMEOUT_MS,
  });
  let settled = false;
  const settle = (found: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resume(Effect.succeed(found));
  };
  socket.once("connect", () => settle(true));
  socket.once("timeout", () => settle(false));
  socket.once("error", () => settle(false));
  return Effect.sync(() => socket.destroy());
});

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const fileSystem = yield* FileSystem.FileSystem;
  // Only the service default listens on every interface without being asked,
  // so only it checks once whether it runs in a cloud. The check starts now so
  // the first client does not wait for its timeout.
  const onCloudVm = config.privateNetworkOnly
    ? yield* Effect.cached(probeCloudMetadata)
    : Effect.succeed(false);
  yield* Effect.forkDetach(onCloudVm);

  const resolveAvailable = Effect.fn("DirectEndpoints.resolveAvailable")(function* () {
    const interfaces = NodeOS.networkInterfaces();
    const isolatedBridges =
      platform === "linux" && isWildcardHost(config.host)
        ? yield* readIsolatedLinuxBridges(Object.keys(interfaces)).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          )
        : undefined;
    return [
      ...resolveBoundEndpoints({
        platform,
        host: config.host,
        port: config.port,
        interfaces,
        onCloudVm: yield* onCloudVm,
        ...(isolatedBridges === undefined ? {} : { isolatedBridges }),
      }),
    ];
  });

  return DirectEndpoints.of({
    resolveAvailable,
    resolve: resolveAvailable,
  });
});

export const layer = Layer.effect(DirectEndpoints, make);
