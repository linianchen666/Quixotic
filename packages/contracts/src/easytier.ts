import * as Schema from "effect/Schema";

import { AuthClientMetadataDeviceType } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";

export const EASYTIER_MESH_PROXY_PREFIX = "/mesh" as const;

export const EasyTierMeshPeer = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  easyTierIp: TrimmedNonEmptyString,
  port: Schema.Int,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  /** Gateway reverse-proxy base URLs on this server, for remote/mobile clients outside EasyTier. */
  gatewayHttpBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  gatewayWsBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  hostname: Schema.optionalKey(TrimmedNonEmptyString),
  latencyMs: Schema.optionalKey(Schema.Number),
  online: Schema.Boolean,
  lastSeenAt: Schema.DateTimeUtc,
});
export type EasyTierMeshPeer = typeof EasyTierMeshPeer.Type;

export const EasyTierMeshStatus = Schema.Struct({
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  localEnvironmentId: EnvironmentId,
  localLabel: TrimmedNonEmptyString,
  localIp: Schema.NullOr(TrimmedNonEmptyString),
  cidr: Schema.NullOr(TrimmedNonEmptyString),
  interfaceName: Schema.NullOr(TrimmedNonEmptyString),
  port: Schema.Int,
  gatewayMode: Schema.Boolean,
  gatewayPasswordConfigured: Schema.Boolean,
  publicGatewayUrl: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * True when the caller is reaching this server from outside the EasyTier/loopback
   * network (for example, a phone reaching a cloud gateway over public IP), so clients
   * should route to peers through `gatewayHttpBaseUrl` instead of direct EasyTier IPs.
   */
  preferGatewayProxy: Schema.Boolean,
  peers: Schema.Array(EasyTierMeshPeer),
  lastScannedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type EasyTierMeshStatus = typeof EasyTierMeshStatus.Type;

export const EasyTierMeshSessionRequest = Schema.Struct({
  clientLabel: Schema.optionalKey(TrimmedNonEmptyString),
  clientDeviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  clientOs: Schema.optionalKey(TrimmedNonEmptyString),
});
export type EasyTierMeshSessionRequest = typeof EasyTierMeshSessionRequest.Type;

export const EasyTierGatewayPasswordUpdateInput = Schema.Struct({
  /** Non-empty string sets or rotates the gateway password; null or empty clears it. */
  password: Schema.NullOr(Schema.String),
});
export type EasyTierGatewayPasswordUpdateInput = typeof EasyTierGatewayPasswordUpdateInput.Type;

export const EasyTierGatewayPasswordUpdateResult = Schema.Struct({
  configured: Schema.Boolean,
});
export type EasyTierGatewayPasswordUpdateResult = typeof EasyTierGatewayPasswordUpdateResult.Type;
