import {
  AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  EASYTIER_MESH_PROXY_PREFIX,
  EnvironmentId,
} from "@t3tools/contracts";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { requestUrl } from "../requestUrl.ts";
import * as EasyTierMesh from "./EasyTierMesh.ts";

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "clear-site-data",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
]);

const decodeTicketResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    ticket: Schema.String,
    expiresAt: Schema.String,
  }),
);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.headers.upgrade?.toLowerCase() === "websocket";

function parseMeshProxyPath(pathname: string): {
  readonly environmentId: EnvironmentId;
  readonly subpath: string;
} | null {
  const prefix = `${EASYTIER_MESH_PROXY_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  const slashIndex = remainder.indexOf("/");
  const rawEnvId = slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
  if (!rawEnvId) return null;
  let decodedEnvId: string;
  try {
    decodedEnvId = decodeURIComponent(rawEnvId);
  } catch {
    return null;
  }
  if (!decodedEnvId || decodedEnvId.includes("/") || decodedEnvId.includes("..")) {
    return null;
  }
  const subpath = slashIndex === -1 ? "/" : remainder.slice(slashIndex) || "/";
  return {
    environmentId: EnvironmentId.make(decodedEnvId),
    subpath,
  };
}

function isSignedCapabilitySubpath(subpath: string): boolean {
  return (
    subpath.startsWith("/api/assets/") ||
    subpath.startsWith("/api/attachment-uploads/")
  );
}

function parseWsTicketSubpath(
  subpath: string,
): { readonly matched: true; readonly use: AuthWebSocketTicketUse | undefined } | { readonly matched: false } {
  if (subpath === "/api/auth/websocket-ticket") {
    return { matched: true, use: undefined };
  }
  if (subpath === "/api/auth/websocket-ticket/rpc") {
    return { matched: true, use: "rpc" };
  }
  if (subpath === "/api/auth/websocket-ticket/media") {
    return { matched: true, use: "media" };
  }
  return { matched: false };
}

function forwardRequestHeaders(
  request: HttpServerRequest.HttpServerRequest,
  peerBearerToken: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || value === undefined) continue;
    headers[lower] = value;
  }
  headers["accept-encoding"] = "identity";
  if (peerBearerToken !== undefined) {
    headers.authorization = `Bearer ${peerBearerToken}`;
  }
  return headers;
}

const pumpFrames = Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
  const { pull } = yield* source.reader;
  while (true) {
    yield* sink.writeAll(yield* pull);
  }
});

const mintUpstreamWebSocketTicket = Effect.fn("GatewayProxy.mintUpstreamWebSocketTicket")(
  function* (input: {
    readonly peerHttpBaseUrl: string;
    readonly peerBearerToken: string;
    readonly use: AuthWebSocketTicketUse;
  }) {
    const httpClient = yield* HttpClient.HttpClient;
    const ticketUrl = `${input.peerHttpBaseUrl}api/auth/websocket-ticket/${input.use}`;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(ticketUrl).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${input.peerBearerToken}`),
        ),
      )
      .pipe(
        Effect.timeoutOption(Duration.seconds(5)),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (Option.isNone(response)) return { status: 502 as const, ticket: null };
    if (response.value.status === 401) return { status: 401 as const, ticket: null };
    if (response.value.status !== 200) return { status: response.value.status, ticket: null };
    const decoded = yield* response.value.json.pipe(
      Effect.flatMap(decodeTicketResponse),
      Effect.orElseSucceed(() => null),
    );
    return decoded === null
      ? { status: 502 as const, ticket: null }
      : { status: 200 as const, ticket: decoded.ticket };
  },
);

const proxyWebSocketToPeer = Effect.fn("GatewayProxy.proxyWebSocketToPeer")(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly environmentId: EnvironmentId;
  readonly peerHttpBaseUrl: string;
  readonly peerWsBaseUrl: string;
  readonly subpath: string;
  readonly searchParams: URLSearchParams;
  readonly use: AuthWebSocketTicketUse;
  readonly invalidated: Effect.Effect<void>;
}) {
  const mesh = yield* EasyTierMesh.EasyTierMesh;
  let tokenOpt = yield* mesh.getPeerBearerToken(input.environmentId);
  if (Option.isNone(tokenOpt)) {
    return HttpServerResponse.text("Target EasyTier node is unreachable or rejected mesh auth.", {
      status: 502,
    });
  }
  let minted = yield* mintUpstreamWebSocketTicket({
    peerHttpBaseUrl: input.peerHttpBaseUrl,
    peerBearerToken: tokenOpt.value,
    use: input.use,
  });
  if (minted.status === 401) {
    tokenOpt = yield* mesh.getPeerBearerToken(input.environmentId, { forceRefresh: true });
    if (Option.isSome(tokenOpt)) {
      minted = yield* mintUpstreamWebSocketTicket({
        peerHttpBaseUrl: input.peerHttpBaseUrl,
        peerBearerToken: tokenOpt.value,
        use: input.use,
      });
    }
  }
  if (minted.ticket === null) {
    return HttpServerResponse.text("Failed to authorize WebSocket to EasyTier node.", {
      status: 502,
    });
  }

  const upstreamUrl = new URL(input.subpath, input.peerWsBaseUrl);
  for (const [key, value] of input.searchParams.entries()) {
    if (key === "wsTicket" || key === "dpop") continue;
    upstreamUrl.searchParams.append(key, value);
  }
  upstreamUrl.searchParams.set("wsTicket", minted.ticket);

  const transport = NodeHttpServerRequest.toIncomingMessage(input.request).socket;
  const client = yield* input.request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl.toString(), {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(upstreamWebSocketConstructor));

  yield* Effect.raceFirst(
    Effect.scoped(
      Effect.gen(function* () {
        const writeToClient = yield* client.writer;
        const writeToUpstream = yield* upstream.writer;
        return yield* Effect.raceFirst(
          pumpFrames(upstream, writeToClient),
          pumpFrames(client, writeToUpstream),
        );
      }),
    ),
    input.invalidated,
  ).pipe(
    Effect.ensuring(Effect.sync(() => transport.destroy())),
    Effect.ignoreCause,
  );
  return HttpServerResponse.empty();
});

const proxyHttpToPeer = Effect.fn("GatewayProxy.proxyHttpToPeer")(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly environmentId: EnvironmentId;
  readonly peerHttpBaseUrl: string;
  readonly subpath: string;
  readonly search: string;
  readonly attachMeshBearer: boolean;
}) {
  const mesh = yield* EasyTierMesh.EasyTierMesh;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = input.request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const upstreamUrl = new URL(`${input.subpath}${input.search}`, input.peerHttpBaseUrl).toString();
  const isBodyless = method === "GET" || method === "HEAD" || method === "OPTIONS";

  const executeOnce = (peerBearerToken: string | undefined) => {
    const upstreamReq = HttpClientRequest.make(method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders(forwardRequestHeaders(input.request, peerBearerToken)),
      isBodyless
        ? (self) => self
        : HttpClientRequest.bodyStream(input.request.stream, {
            contentType: input.request.headers["content-type"],
          }),
    );
    return httpClient.execute(upstreamReq);
  };

  let peerBearerToken: string | undefined;
  if (input.attachMeshBearer) {
    const tokenOpt = yield* mesh.getPeerBearerToken(input.environmentId);
    if (Option.isNone(tokenOpt)) {
      return HttpServerResponse.text("Target EasyTier node could not issue a mesh session.", {
        status: 502,
      });
    }
    peerBearerToken = tokenOpt.value;
  }

  let response = yield* executeOnce(peerBearerToken).pipe(Effect.orElseSucceed(() => null));
  if (response !== null && response.status === 401 && input.attachMeshBearer && isBodyless) {
    const refreshed = yield* mesh.getPeerBearerToken(input.environmentId, { forceRefresh: true });
    if (Option.isSome(refreshed)) {
      response = yield* executeOnce(refreshed.value).pipe(Effect.orElseSucceed(() => null));
    }
  }
  if (response === null) {
    return HttpServerResponse.text("Target EasyTier node is unreachable.", { status: 502 });
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
    headers[lower] = value;
  }

  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handleGatewayProxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urlOpt = requestUrl(request);
  if (Option.isNone(urlOpt)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const parsed = parseMeshProxyPath(urlOpt.value.pathname);
  if (parsed === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }

  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const mesh = yield* EasyTierMesh.EasyTierMesh;
  const upgrade = isWebSocketUpgrade(request);
  const signedCapability = !upgrade && isSignedCapabilitySubpath(parsed.subpath);

  // 1. Strictly authenticate caller on the gateway BEFORE resolving or contacting mesh peers,
  //    except for signed short-lived capability asset/upload URLs whose path token authenticates them.
  let callerSession: EnvironmentAuth.AuthenticatedSession | undefined;
  if (upgrade) {
    const wsUse: AuthWebSocketTicketUse = parsed.subpath === "/ws" ? "rpc" : "media";
    callerSession = yield* serverAuth.authenticateWebSocketUpgrade(request, wsUse).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
  } else if (!signedCapability) {
    callerSession = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
  }

  // 2. Resolve target peer from EasyTier mesh registry.
  const peerOpt = yield* mesh.getPeer(parsed.environmentId);
  if (Option.isNone(peerOpt)) {
    return HttpServerResponse.text("EasyTier environment not found or offline.", { status: 404 });
  }
  const peer = peerOpt.value;

  // 3. Intercept websocket-ticket minting locally so the gateway validates the caller's ticket
  //    on `/mesh/:envId/ws`, then exchanges for a fresh upstream peer ticket over EasyTier.
  if (!upgrade && request.method === "POST" && callerSession !== undefined) {
    const ticketRoute = parseWsTicketSubpath(parsed.subpath);
    if (ticketRoute.matched) {
      const issued = yield* serverAuth
        .issueWebSocketTicket(callerSession, ticketRoute.use ? { use: ticketRoute.use } : undefined)
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        );
      return yield* HttpServerResponse.json(
        {
          ticket: Redacted.value(issued.ticket),
          expiresAt: DateTime.formatIso(issued.expiresAt),
        },
        {
          headers: {
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        },
      );
    }
  }

  // 4. WebSocket reverse proxy
  if (upgrade && callerSession !== undefined) {
    const invalidated = sessions.awaitInvalidation(callerSession.sessionId).pipe(
      Effect.catchTags({
        SessionCredentialVerificationError: (error) =>
          failEnvironmentInternal("internal_error", error).pipe(Effect.ignore),
      }),
    );
    return yield* proxyWebSocketToPeer({
      request,
      environmentId: parsed.environmentId,
      peerHttpBaseUrl: peer.httpBaseUrl,
      peerWsBaseUrl: peer.wsBaseUrl,
      subpath: parsed.subpath,
      searchParams: urlOpt.value.searchParams,
      use: parsed.subpath === "/ws" ? "rpc" : "media",
      invalidated,
    });
  }

  // 5. HTTP reverse proxy
  return yield* proxyHttpToPeer({
    request,
    environmentId: parsed.environmentId,
    peerHttpBaseUrl: peer.httpBaseUrl,
    subpath: parsed.subpath,
    search: urlOpt.value.search,
    attachMeshBearer: !signedCapability && parsed.subpath !== "/.well-known/t3/environment",
  });
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
  }),
);

// Exported for schema type check sanity
export type GatewayProxyTicketResult = AuthWebSocketTicketResult;

export const layer = HttpRouter.add("*", `${EASYTIER_MESH_PROXY_PREFIX}/:environmentId/*`, handleGatewayProxy);
