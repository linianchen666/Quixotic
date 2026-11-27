import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  appendCredentialResponseHeaders,
  appendSessionCookie,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as EasyTierMesh from "./EasyTierMesh.ts";
import { GATEWAY_PASSWORD_MIN_LENGTH } from "./GatewayPassword.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "easytier",
  Effect.fnUntraced(function* (handlers) {
    const mesh = yield* EasyTierMesh.EasyTierMesh;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "status",
        Effect.fn("environment.easytier.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          return yield* mesh.getStatusForRequest(request);
        }),
      )
      .handle(
        "refresh",
        Effect.fn("environment.easytier.refresh")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* mesh.refresh();
          return yield* mesh.getStatusForRequest(request);
        }),
      )
      .handle(
        "setGatewayPassword",
        Effect.fn("environment.easytier.setGatewayPassword")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const raw = args.payload.password?.trim() ?? "";
            if (raw.length > 0 && raw.length < GATEWAY_PASSWORD_MIN_LENGTH) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
            const configured = yield* serverAuth.setGatewayPassword(raw.length > 0 ? raw : null);
            return { configured };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "meshSession",
        Effect.fn("environment.easytier.meshSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (!mesh.isDirectEasyTierRequest(request)) {
              return yield* failEnvironmentAuthInvalid("invalid_credential");
            }
            const metadata = deriveAuthClientMetadata({
              request,
              presented: {
                ...(args.payload.clientLabel ? { label: args.payload.clientLabel } : {}),
                ...(args.payload.clientDeviceType
                  ? { deviceType: args.payload.clientDeviceType }
                  : {}),
                ...(args.payload.clientOs ? { os: args.payload.clientOs } : {}),
              },
            });
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueEasyTierMeshSession(metadata);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "meshBrowserSession",
        Effect.fn("environment.easytier.meshBrowserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (!mesh.isDirectEasyTierRequest(request)) {
              return yield* failEnvironmentAuthInvalid("invalid_credential");
            }
            const previousCredential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            const metadata = deriveAuthClientMetadata({
              request,
              presented: {
                ...(args.payload.clientLabel ? { label: args.payload.clientLabel } : {}),
                ...(args.payload.clientDeviceType
                  ? { deviceType: args.payload.clientDeviceType }
                  : {}),
                ...(args.payload.clientOs ? { os: args.payload.clientOs } : {}),
              },
            });
            const result = yield* serverAuth.issueEasyTierMeshBrowserSession(
              metadata,
              previousCredential &&
                EnvironmentAuth.isBrowserCookieCredential(previousCredential.source)
                ? previousCredential.token
                : undefined,
            );
            yield* appendSessionCookie(
              request,
              sessions.cookieName,
              result.sessionToken,
              result.response.expiresAt,
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      );
  }),
);
