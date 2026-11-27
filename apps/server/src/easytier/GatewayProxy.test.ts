// @effect-diagnostics globalFetchInEffect:off -- Black-box HTTP integration test using fetch to simulate browser and mobile clients.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket } from "@effect/platform-node/NodeWS";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Spins up two real isolated Node HTTP servers for end-to-end EasyTier gateway HTTP + WS proxy testing.
import * as NodeHttp from "node:http";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EasyTierMesh from "./EasyTierMesh.ts";
import * as GatewayProxy from "./GatewayProxy.ts";
import * as EasyTierHttp from "./http.ts";

class EasyTierTestApi extends HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.easytier) {}

const layerMetadataHandlers = HttpApiBuilder.group(EasyTierTestApi, "metadata", (handlers) =>
  handlers.handle("descriptor", () =>
    Effect.flatMap(ServerEnvironment.ServerEnvironment, (env) => env.getDescriptor),
  ),
);

const layerPeerProtectedRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const env = yield* ServerEnvironment.ServerEnvironment;

    yield* router.add(
      "GET",
      "/api/projects",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
        if (session._tag === "None") {
          return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
        }
        const environmentId = yield* env.getEnvironmentId;
        return HttpServerResponse.jsonUnsafe({
          environmentId,
          projects: [{ id: "proj-1", name: "peer-repo" }],
        });
      }),
    );

    yield* router.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const upgraded = yield* auth.authenticateWebSocketUpgrade(request, "rpc").pipe(Effect.option);
        if (upgraded._tag === "None") {
          return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
        }
        const socket = yield* request.upgrade;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* socket.writer;
            const { pull } = yield* socket.reader;
            const decoder = new TextDecoder();
            while (true) {
              const chunks = yield* pull;
              const replies = chunks.map((chunk) => {
                const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
                return `pong:${text}`;
              });
              const [firstReply, ...restReplies] = replies;
              if (firstReply !== undefined) {
                yield* writer.writeAll([firstReply, ...restReplies]);
              }
            }
          }),
        ).pipe(Effect.ignoreCause);
        return HttpServerResponse.empty();
      }),
    );
  }),
);

const startIsolatedTestServer = (input: {
  readonly prefix: string;
  readonly easyTierCidr: string;
  readonly easyTierPeers?: ReadonlyArray<string>;
  readonly gatewayMode?: boolean;
  readonly gatewayPassword?: string;
  readonly includeGatewayProxy?: boolean;
  readonly includePeerRoutes?: boolean;
}) =>
  Effect.gen(function* () {
    const layerConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (base) => ({
        ...base,
        mode: "web" as const,
        host: "127.0.0.1",
        port: 0,
        easyTierEnabled: true,
        easyTierCidr: input.easyTierCidr,
        ...(input.easyTierPeers ? { easyTierPeers: input.easyTierPeers } : {}),
        ...(input.gatewayMode ? { gatewayMode: true } : {}),
        ...(input.gatewayPassword
          ? { gatewayPassword: Redacted.make(input.gatewayPassword) }
          : {}),
      })),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: input.prefix })));

    const layerEnvIdentity = ServerEnvironment.layerIdentity.pipe(Layer.provide(layerConfig));
    const layerServerEnvironment = Layer.effect(
      ServerEnvironment.ServerEnvironment,
      Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const environmentId = yield* identity.getEnvironmentId;
        return ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.succeed({
            environmentId,
            label: input.prefix,
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: {
              repositoryIdentity: true,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
          }),
        });
      }),
    ).pipe(Layer.provide(layerEnvIdentity));
    const layerSecretStore = ServerSecretStore.layer.pipe(Layer.provide(layerConfig));
    const layerBase = Layer.mergeAll(
      layerConfig,
      layerEnvIdentity,
      layerServerEnvironment,
      layerSecretStore,
      ManagedPolicy.layerTest(),
      SqlitePersistence.layerMemory,
      FetchHttpClient.layer,
    );
    const layerAuth = EnvironmentAuth.layer.pipe(Layer.provideMerge(layerBase));
    const layerAuthMiddleware = AuthHttp.layerAuthenticatedAuth.pipe(Layer.provideMerge(layerAuth));
    const layerServer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: "127.0.0.1",
      port: 0,
    });
    const layerServices = EasyTierMesh.layer.pipe(
      Layer.provideMerge(layerServer),
      Layer.provideMerge(layerAuthMiddleware),
    );
    const layerApi = HttpApiBuilder.layer(EasyTierTestApi).pipe(
      Layer.provide(layerMetadataHandlers),
      Layer.provide(AuthHttp.layer),
      Layer.provide(EasyTierHttp.layer),
    );
    const routes = [
      layerApi,
      ...(input.includeGatewayProxy ? [GatewayProxy.layer] : []),
      ...(input.includePeerRoutes ? [layerPeerProtectedRoutes] : []),
    ] as const;

    const appLayer = HttpRouter.serve(Layer.mergeAll(...routes)).pipe(
      Layer.provideMerge(layerServices),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

    const ctx = yield* Layer.build(appLayer);
    const server = ctx.mapUnsafe.get(HttpServer.HttpServer.key) as HttpServer.HttpServer["Service"];
    const envService = ctx.mapUnsafe.get(
      ServerEnvironment.ServerEnvironment.key,
    ) as ServerEnvironment.ServerEnvironment["Service"];
    const address = server.address;
    if (typeof address !== "object" || address === null || !("port" in address)) {
      throw new Error("Expected TCP server address");
    }
    const environmentId = yield* envService.getEnvironmentId;
    return {
      port: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
      wsBaseUrl: `ws://127.0.0.1:${address.port}`,
      environmentId,
    };
  });

const waitForWebSocketRoundtrip = (url: string, message: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.send(message);
    });
    ws.addEventListener("message", (event) => {
      settled = true;
      const data = typeof event.data === "string" ? event.data : String(event.data);
      ws.close();
      resolve(data);
    });
    ws.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error("WebSocket connection failed"));
      }
    });
    ws.addEventListener("close", (event) => {
      if (!settled) {
        settled = true;
        reject(new Error(`WebSocket closed before message (${event.code})`));
      }
    });
  });

const expectWebSocketRejected = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      ws.close();
      resolve(false);
    });
    ws.addEventListener("error", () => {
      resolve(true);
    });
    ws.addEventListener("close", () => {
      resolve(true);
    });
  });

it.live(
  "enforces mesh trust, authenticates gateway logins, and proxies HTTP + WebSocket to EasyTier peers",
  () =>
    Effect.gen(function* () {
      const peer = yield* startIsolatedTestServer({
        prefix: "t3-easytier-peer-",
        easyTierCidr: "127.0.0.1/32",
        includePeerRoutes: true,
      });

      const gateway = yield* startIsolatedTestServer({
        prefix: "t3-easytier-gateway-",
        easyTierCidr: "127.0.0.1/32",
        easyTierPeers: [`127.0.0.1:${peer.port}`],
        gatewayMode: true,
        gatewayPassword: "test-gateway-secret",
        includeGatewayProxy: true,
      });

      yield* Effect.promise(async () => {
        // 1. Unauthenticated requests to gateway mesh endpoints MUST be rejected (401)
        const unauthStatus = await fetch(`${gateway.baseUrl}/api/easytier/status`, {
          headers: { "x-forwarded-for": "203.0.113.50" },
        });
        expect(unauthStatus.status).toBe(401);

        const unauthProxyDesc = await fetch(
          `${gateway.baseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/.well-known/t3/environment`,
          { headers: { "x-forwarded-for": "203.0.113.50" } },
        );
        expect(unauthProxyDesc.status).toBe(401);

        const unauthProxyApi = await fetch(
          `${gateway.baseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/api/projects`,
          { headers: { "x-forwarded-for": "203.0.113.50" } },
        );
        expect(unauthProxyApi.status).toBe(401);

        const unauthWsRejected = await expectWebSocketRejected(
          `${gateway.wsBaseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
        );
        expect(unauthWsRejected).toBe(true);

        // 2. Spoofed proxy headers MUST block zero-pairing EasyTier session minting on Peer
        const spoofedMesh = await fetch(`${peer.baseUrl}/api/easytier/mesh-session`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.99",
          },
          body: JSON.stringify({ clientLabel: "spoofed" }),
        });
        expect(spoofedMesh.status).toBe(401);

        // 3. Direct EasyTier peer request WITHOUT proxy headers succeeds with zero pairing
        const directMesh = await fetch(`${peer.baseUrl}/api/easytier/mesh-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientLabel: "direct-easytier-desktop" }),
        });
        expect(directMesh.status).toBe(200);
        const directMeshJson = (await directMesh.json()) as { access_token: string };
        expect(directMeshJson.access_token.length).toBeGreaterThan(10);

        // 4. Gateway password authentication: wrong password fails, right password issues Bearer + Cookie
        const badTokenRes = await fetch(`${gateway.baseUrl}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: "wrong-password",
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }),
        });
        expect(badTokenRes.status).toBe(401);

        const goodTokenRes = await fetch(`${gateway.baseUrl}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: "test-gateway-secret",
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }),
        });
        expect(goodTokenRes.status).toBe(200);
        const { access_token: gatewayBearer } = (await goodTokenRes.json()) as {
          access_token: string;
        };

        const browserLoginRes = await fetch(`${gateway.baseUrl}/api/auth/browser-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential: "test-gateway-secret" }),
        });
        expect(browserLoginRes.status).toBe(200);
        const rawSetCookie = browserLoginRes.headers.get("set-cookie");
        expect(rawSetCookie).toBeTruthy();
        const gatewayCookie = rawSetCookie!.split(";", 1)[0]!;

        // 5. Gateway refreshes EasyTier mesh and returns gateway proxy URLs for external callers
        const refreshRes = await fetch(`${gateway.baseUrl}/api/easytier/refresh`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${gatewayBearer}`,
            "x-forwarded-for": "203.0.113.50",
          },
        });
        expect(refreshRes.status).toBe(200);
        const meshStatus = (await refreshRes.json()) as {
          readonly enabled: boolean;
          readonly preferGatewayProxy: boolean;
          readonly gatewayPasswordConfigured: boolean;
          readonly peers: ReadonlyArray<{
            readonly environmentId: string;
            readonly online: boolean;
            readonly gatewayHttpBaseUrl?: string;
            readonly gatewayWsBaseUrl?: string;
          }>;
        };
        expect(meshStatus.enabled).toBe(true);
        expect(meshStatus.preferGatewayProxy).toBe(true);
        expect(meshStatus.gatewayPasswordConfigured).toBe(true);
        const discoveredPeer = meshStatus.peers.find((p) => p.environmentId === peer.environmentId);
        expect(discoveredPeer).toBeDefined();
        expect(discoveredPeer?.online).toBe(true);
        expect(discoveredPeer?.gatewayHttpBaseUrl).toContain(
          `/mesh/${encodeURIComponent(peer.environmentId)}/`,
        );
        expect(discoveredPeer?.gatewayWsBaseUrl).toContain(
          `/mesh/${encodeURIComponent(peer.environmentId)}/`,
        );

        // 6. Authenticated HTTP proxying (both Bearer for Mobile App and Cookie for Mobile Web)
        const proxiedDesc = await fetch(
          `${gateway.baseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/.well-known/t3/environment`,
          { headers: { cookie: gatewayCookie } },
        );
        expect(proxiedDesc.status).toBe(200);
        expect(proxiedDesc.headers.get("set-cookie")).toBeNull();
        expect(await proxiedDesc.json()).toMatchObject({ environmentId: peer.environmentId });

        const proxiedProjects = await fetch(
          `${gateway.baseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/api/projects`,
          { headers: { authorization: `Bearer ${gatewayBearer}` } },
        );
        expect(proxiedProjects.status).toBe(200);
        expect(await proxiedProjects.json()).toEqual({
          environmentId: peer.environmentId,
          projects: [{ id: "proj-1", name: "peer-repo" }],
        });

        // 7. Authenticated WebSocket proxying through Gateway (/mesh/<peerId>/api/auth/websocket-ticket/rpc + /ws)
        const wsTicketRes = await fetch(
          `${gateway.baseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/api/auth/websocket-ticket/rpc`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${gatewayBearer}` },
          },
        );
        expect(wsTicketRes.status).toBe(200);
        const { ticket: gatewayWsTicket } = (await wsTicketRes.json()) as { ticket: string };
        expect(gatewayWsTicket.length).toBeGreaterThan(10);

        const wsReply = await waitForWebSocketRoundtrip(
          `${gateway.wsBaseUrl}/mesh/${encodeURIComponent(peer.environmentId)}/ws?wsTicket=${encodeURIComponent(gatewayWsTicket)}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
          "hello-mesh",
        );
        expect(wsReply).toBe("pong:hello-mesh");
      });
    }).pipe(Effect.scoped),
);
