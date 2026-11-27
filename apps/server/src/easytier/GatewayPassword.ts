// @effect-diagnostics nodeBuiltinImport:off -- Uses node:crypto scryptSync and timingSafeEqual for constant-time password hashing.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const GATEWAY_PASSWORD_SECRET_NAME = "easytier-gateway-password-hash";
export const GATEWAY_PASSWORD_MIN_LENGTH = 4;

const SCRYPT_PREFIX = "scrypt:v1:";
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = NodeCrypto.createHash("sha256").update(left, "utf8").digest();
  const rightDigest = NodeCrypto.createHash("sha256").update(right, "utf8").digest();
  return NodeCrypto.timingSafeEqual(leftDigest, rightDigest);
}

export function hashGatewayPassword(password: string): string {
  const salt = NodeCrypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = NodeCrypto.scryptSync(password, salt, SCRYPT_KEY_BYTES);
  return `${SCRYPT_PREFIX}${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyGatewayPasswordHash(candidate: string, encodedHash: string): boolean {
  if (!encodedHash.startsWith(SCRYPT_PREFIX)) return false;
  const payload = encodedHash.slice(SCRYPT_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator <= 0 || separator !== payload.lastIndexOf(":")) return false;
  const saltHex = payload.slice(0, separator);
  const keyHex = payload.slice(separator + 1);
  if (!/^[\da-f]+$/iu.test(saltHex) || !/^[\da-f]+$/iu.test(keyHex)) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  if (salt.byteLength === 0 || expected.byteLength !== SCRYPT_KEY_BYTES) return false;
  const actual = NodeCrypto.scryptSync(candidate, salt, SCRYPT_KEY_BYTES);
  return NodeCrypto.timingSafeEqual(actual, expected);
}

export const readStoredGatewayPasswordHash = (
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
) =>
  secretStore.get(GATEWAY_PASSWORD_SECRET_NAME).pipe(
    Effect.map(
      Option.map((bytes) => new TextDecoder().decode(bytes).trim()),
    ),
    Effect.map(Option.filter((value) => value.length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

export const isGatewayPasswordConfigured = Effect.fn("GatewayPassword.isConfigured")(function* (
  config: Pick<ServerConfig.ServerConfig["Service"], "gatewayPassword">,
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
) {
  if (config.gatewayPassword && Redacted.value(config.gatewayPassword).trim().length > 0) {
    return true;
  }
  return Option.isSome(yield* readStoredGatewayPasswordHash(secretStore));
});

export const verifyGatewayPassword = Effect.fn("GatewayPassword.verify")(function* (
  candidate: string,
  config: Pick<ServerConfig.ServerConfig["Service"], "gatewayPassword">,
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
) {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return false;
  if (config.gatewayPassword !== undefined) {
    const envPassword = Redacted.value(config.gatewayPassword).trim();
    if (envPassword.length > 0 && constantTimeStringEqual(trimmed, envPassword)) {
      return true;
    }
  }
  const storedHash = yield* readStoredGatewayPasswordHash(secretStore);
  if (Option.isSome(storedHash)) {
    return verifyGatewayPasswordHash(trimmed, storedHash.value);
  }
  return false;
});

export const persistGatewayPassword = Effect.fn("GatewayPassword.persist")(function* (
  password: string | null,
  secretStore: ServerSecretStore.ServerSecretStore["Service"],
) {
  const trimmed = password?.trim() ?? "";
  if (trimmed.length === 0) {
    yield* secretStore.remove(GATEWAY_PASSWORD_SECRET_NAME);
    return false;
  }
  const encoded = hashGatewayPassword(trimmed);
  yield* secretStore.set(GATEWAY_PASSWORD_SECRET_NAME, new TextEncoder().encode(encoded));
  return true;
});
