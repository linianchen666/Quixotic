import type * as NodeOS from "node:os";
import * as Headers from "effect/http/Headers";
import { describe, expect, it } from "vite-plus/test";

import {
  detectLocalEasyTierInterface,
  enumerateSubnetHosts,
  isDirectEasyTierRequest,
  isRequestFromOutsideMesh,
  parseEasyTierCliPeersJson,
  parseStaticEasyTierPeerSpec,
} from "./EasyTierMesh.ts";
import { hashGatewayPassword, verifyGatewayPasswordHash } from "./GatewayPassword.ts";

const ipv4Entry = (address: string, cidr: string, internal = false) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr,
});

describe("EasyTierMesh interface detection", () => {
  it("detects a Linux tun0 EasyTier subnet while ignoring Clash fake-IP, Tailscale, and Docker", () => {
    const interfaces: ReturnType<typeof NodeOS.networkInterfaces> = {
      lo: [ipv4Entry("127.0.0.1", "127.0.0.1/8", true)],
      eth0: [ipv4Entry("192.168.1.20", "192.168.1.20/24")],
      docker0: [ipv4Entry("172.17.0.1", "172.17.0.1/16")],
      utun9: [ipv4Entry("198.18.0.1", "198.18.0.1/15")],
      tailscale0: [ipv4Entry("100.101.102.103", "100.101.102.103/32")],
      tun0: [ipv4Entry("10.126.126.20", "10.126.126.20/24")],
    };

    expect(detectLocalEasyTierInterface(interfaces, "linux")).toEqual({
      localIp: "10.126.126.20",
      cidr: "10.126.126.0/24",
      interfaceName: "tun0",
    });
  });

  it("detects Windows EasyTier / Wintun adapters and ignores Mihomo fake-IP TUN", () => {
    const interfaces: ReturnType<typeof NodeOS.networkInterfaces> = {
      Mihomo: [ipv4Entry("198.18.0.1", "198.18.0.1/15")],
      "Ethernet 2": [ipv4Entry("192.168.1.10", "192.168.1.10/24")],
      "EasyTier Tunnel": [ipv4Entry("10.126.126.10", "10.126.126.10/24")],
    };

    expect(detectLocalEasyTierInterface(interfaces, "win32")).toEqual({
      localIp: "10.126.126.10",
      cidr: "10.126.126.0/24",
      interfaceName: "EasyTier Tunnel",
    });
  });

  it("detects Windows EasyTier et_* adapter names and localized zero-MAC Wintun adapters", () => {
    const withUnderscore: ReturnType<typeof NodeOS.networkInterfaces> = {
      Mihomo: [ipv4Entry("198.18.0.1", "198.18.0.1/15")],
      "Ethernet 2": [{ ...ipv4Entry("192.168.1.10", "192.168.1.10/24"), mac: "aa:bb:cc:dd:ee:ff" }],
      et_9a3bf1c0: [ipv4Entry("10.126.126.10", "10.126.126.10/24")],
    };
    expect(detectLocalEasyTierInterface(withUnderscore, "win32")).toEqual({
      localIp: "10.126.126.10",
      cidr: "10.126.126.0/24",
      interfaceName: "et_9a3bf1c0",
    });

    const localizedWintun: ReturnType<typeof NodeOS.networkInterfaces> = {
      Mihomo: [ipv4Entry("198.18.0.1", "198.18.0.1/15")],
      "以太网": [{ ...ipv4Entry("192.168.1.10", "192.168.1.10/24"), mac: "aa:bb:cc:dd:ee:ff" }],
      "本地连接* 12": [ipv4Entry("10.126.126.10", "10.126.126.10/24")],
    };
    expect(detectLocalEasyTierInterface(localizedWintun, "win32")).toEqual({
      localIp: "10.126.126.10",
      cidr: "10.126.126.0/24",
      interfaceName: "本地连接* 12",
    });
  });

  it("honors explicit override CIDR even on custom interface names", () => {
    const interfaces: ReturnType<typeof NodeOS.networkInterfaces> = {
      custom0: [ipv4Entry("10.88.0.5", "10.88.0.5/24")],
    };

    expect(detectLocalEasyTierInterface(interfaces, "linux", "10.88.0.0/24")).toEqual({
      localIp: "10.88.0.5",
      cidr: "10.88.0.0/24",
      interfaceName: "custom0",
    });
  });
});

describe("EasyTierMesh request trust boundary", () => {
  const makeRequest = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({
    headers: Headers.fromInput(headers),
    source: {
      socket: { remoteAddress },
    },
  });

  it("trusts direct TCP peers inside the EasyTier CIDR without proxy headers", () => {
    expect(isDirectEasyTierRequest(makeRequest("10.126.126.10"), "10.126.126.0/24")).toBe(true);
    expect(isDirectEasyTierRequest(makeRequest("::ffff:10.126.126.10"), "10.126.126.0/24")).toBe(
      true,
    );
  });

  it("rejects public IPs and rejects proxied requests even if the TCP peer is in the mesh CIDR", () => {
    expect(isDirectEasyTierRequest(makeRequest("203.0.113.5"), "10.126.126.0/24")).toBe(false);
    expect(isDirectEasyTierRequest(makeRequest("192.168.1.10"), "10.126.126.0/24")).toBe(false);
    expect(isDirectEasyTierRequest(makeRequest("10.126.126.10"), null)).toBe(false);

    for (const header of [
      "x-forwarded-for",
      "forwarded",
      "x-real-ip",
      "cf-connecting-ip",
      "true-client-ip",
    ]) {
      expect(
        isDirectEasyTierRequest(
          makeRequest("10.126.126.254", { [header]: "203.0.113.42" }),
          "10.126.126.0/24",
        ),
      ).toBe(false);
    }
  });

  it("classifies requests from outside the mesh so gateways prefer proxy URLs", () => {
    expect(isRequestFromOutsideMesh(makeRequest("127.0.0.1"), "10.126.126.0/24", true)).toBe(false);
    expect(isRequestFromOutsideMesh(makeRequest("10.126.126.10"), "10.126.126.0/24", true)).toBe(
      false,
    );
    expect(isRequestFromOutsideMesh(makeRequest("203.0.113.5"), "10.126.126.0/24", false)).toBe(
      true,
    );
    expect(
      isRequestFromOutsideMesh(
        makeRequest("127.0.0.1", { "x-forwarded-for": "203.0.113.5" }),
        "10.126.126.0/24",
        false,
      ),
    ).toBe(true);
  });
});

describe("EasyTierMesh CLI and peer parsing", () => {
  it("parses easytier-cli JSON output while skipping Local and fake-IP entries", () => {
    const output = JSON.stringify([
      { ipv4: "10.126.126.20/24", hostname: "linux-box", cost: "Local", lat_ms: "-" },
      { ipv4: "10.126.126.10/24", hostname: "win-main", cost: "p2p", lat_ms: "1.42" },
      { ipv4: "10.126.126.254", hostname: "cloud-gw", cost: "p2p", lat_ms: 14.5 },
      { ipv4: "198.18.0.1", hostname: "clash-tun", cost: "p2p", lat_ms: 0.1 },
    ]);

    expect(parseEasyTierCliPeersJson(output)).toEqual([
      { ipv4: "10.126.126.10", hostname: "win-main", latencyMs: 1.42 },
      { ipv4: "10.126.126.254", hostname: "cloud-gw", latencyMs: 14.5 },
    ]);
  });

  it("parses static peer specs and enumerates /24 subnet hosts excluding local IP", () => {
    expect(parseStaticEasyTierPeerSpec("10.126.126.10", 3773)).toEqual({
      ip: "10.126.126.10",
      port: 3773,
    });
    expect(parseStaticEasyTierPeerSpec("http://10.126.126.10:4000/", 3773)).toEqual({
      ip: "10.126.126.10",
      port: 4000,
    });
    expect(parseStaticEasyTierPeerSpec("198.18.0.1:3773", 3773)).toBeNull();

    const hosts = enumerateSubnetHosts("10.126.126.0/24", "10.126.126.20");
    expect(hosts).toHaveLength(253);
    expect(hosts).not.toContain("10.126.126.0");
    expect(hosts).not.toContain("10.126.126.255");
    expect(hosts).not.toContain("10.126.126.20");
    expect(hosts).toContain("10.126.126.1");
    expect(hosts).toContain("10.126.126.254");
  });
});

describe("GatewayPassword", () => {
  it("hashes and verifies passwords in constant time and rejects invalid hashes or wrong secrets", () => {
    const hash = hashGatewayPassword("my-gateway-secret");
    expect(hash.startsWith("scrypt:v1:")).toBe(true);
    expect(verifyGatewayPasswordHash("my-gateway-secret", hash)).toBe(true);
    expect(verifyGatewayPasswordHash("wrong-secret", hash)).toBe(false);
    expect(verifyGatewayPasswordHash("my-gateway-secret", "plain:not-a-hash")).toBe(false);
  });
});
