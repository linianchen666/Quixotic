import {
  ClientCapabilities,
  Persistence,
  PlatformConnectionSource,
} from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  CredentialStore,
  type PlatformConnectionRegistration,
  ProfileStore,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import {
  bootstrapEasyTierMeshSession,
  fetchEasyTierMeshStatus,
} from "@t3tools/client-runtime/authorization";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Clock from "effect/Clock";
import { msg } from "gt-react-native";
import { m } from "../i18n/messages";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as MobileStorage from "../persistence/mobile-storage";
import { appAtomRegistry } from "../state/atom-registry";
import { mobileApplicationActiveWakeup } from "./app-state-wakeups";
import * as EnvironmentOwnedDataCleanup from "./environment-owned-data-cleanup";
import * as ConnectionStorage from "./storage";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

const layerConnectivity = Connectivity.layer({
  status: Effect.tryPromise({
    try: () => Network.getNetworkStateAsync(),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => "unknown" as const,
      onSuccess: networkStatus,
    }),
  ),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const networkSubscription = Network.addNetworkStateListener((state) => {
          Queue.offerUnsafe(queue, networkStatus(state));
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") {
            return;
          }
          void Network.getNetworkStateAsync()
            .then((current) => {
              if (active) {
                Queue.offerUnsafe(queue, networkStatus(current));
              }
            })
            .catch(() => undefined);
        });
        return {
          close: () => {
            active = false;
            networkSubscription.remove();
            appStateSubscription.remove();
          },
        };
      }),
      ({ close }) => Effect.sync(close),
    ).pipe(Effect.asVoid),
  ),
});

/** Wake connections on network path changes; online/offline misses Wi-Fi-to-cellular moves. */
const networkPathChanges = Stream.callback<"network-changed">((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let active = true;
      let previous: Network.NetworkStateType | undefined;
      const record = (state: Network.NetworkState) => {
        const type = state.isConnected === true ? state.type : undefined;
        if (previous !== undefined && type !== undefined && type !== previous) {
          Queue.offerUnsafe(queue, "network-changed");
        }
        previous = type ?? previous;
      };
      // Seed the current type: the listener reports only changes and would miss the first move.
      void Network.getNetworkStateAsync()
        .then((state) => {
          if (active && previous === undefined && state.isConnected === true) {
            previous = state.type;
          }
        })
        .catch(() => undefined);
      const subscription = Network.addNetworkStateListener(record);
      return {
        remove: () => {
          active = false;
          subscription.remove();
        },
      };
    }),
    (subscription) => Effect.sync(() => subscription.remove()),
  ).pipe(Effect.asVoid),
);

const layerWakeups = Wakeups.layer({
  changes: Stream.mergeAll(
    [
      Stream.callback<"application-active-probe" | "application-active-long">((queue) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            let backgroundedAtMs = AppState.currentState === "background" ? nowMs : null;
            return AppState.addEventListener("change", (state) => {
              if (state === "background") {
                backgroundedAtMs = Date.now();
                return;
              }
              if (state === "active") {
                Queue.offerUnsafe(
                  queue,
                  mobileApplicationActiveWakeup(backgroundedAtMs, Date.now()),
                );
                backgroundedAtMs = null;
              }
            });
          }),
          (subscription) => Effect.sync(() => subscription.remove()),
        ).pipe(Effect.asVoid),
      ),
      managedRelayAccountChanges(appAtomRegistry).pipe(
        Stream.map(() => "credentials-changed" as const),
      ),
      networkPathChanges,
    ],
    { concurrency: "unbounded" },
  ),
});

const layerCapabilities = Layer.effectContext(
  Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    return Context.make(
      ClientCapabilities.CloudSession,
      ClientCapabilities.CloudSession.of({
        identity: Effect.sync(() =>
          Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
        ),
        clerkToken: Effect.gen(function* () {
          const session = appAtomRegistry.get(managedRelaySessionAtom);
          if (session === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: m(
                msg("Sign in to {product} to connect this environment.", { product: "Self-hosted relay" }),
              ),
            });
          }
          const token = yield* session.readClerkToken().pipe(
            Effect.mapError(
              (error) =>
                new ConnectionTransientError({
                  reason: "network",
                  detail: error.message,
                }),
            ),
          );
          if (token === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: m(msg("The {product} session is unavailable.", { product: "Self-hosted relay" })),
            });
          }
          return token;
        }),
      }),
    ).pipe(
      Context.add(
        ClientCapabilities.PrimaryEnvironmentAuth,
        ClientCapabilities.PrimaryEnvironmentAuth.of({
          bearerToken: Effect.succeedNone,
        }),
      ),
      Context.add(
        ClientCapabilities.RelayDeviceIdentity,
        ClientCapabilities.RelayDeviceIdentity.of({
          deviceId: storage.loadOrCreateAgentAwarenessDeviceId.pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: m(
                    msg("Could not load the mobile device identity: {cause}", {
                      cause: String(cause),
                    }),
                  ),
                }),
            ),
            Effect.asSome,
          ),
        }),
      ),
      Context.add(
        ClientCapabilities.ClientPresentation,
        ClientCapabilities.ClientPresentation.of({
          metadata: authClientMetadata(Constants.expoConfig?.version),
        }),
      ),
      Context.add(
        ClientCapabilities.SshEnvironmentGateway,
        ClientCapabilities.SshEnvironmentGateway.of({
          provision: Effect.fn("ClientCapabilities.SshEnvironmentGateway.provision")(() =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: m(
                  msg("{feature} environments are only available in the desktop app.", {
                    feature: "SSH",
                  }),
                ),
              }),
            ),
          ),
          prepare: Effect.fn("ClientCapabilities.SshEnvironmentGateway.prepare")(() =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: m(
                  msg("{feature} environments are only available in the desktop app.", {
                    feature: "SSH",
                  }),
                ),
              }),
            ),
          ),
          disconnect: Effect.fn("ClientCapabilities.SshEnvironmentGateway.disconnect")(
            () => Effect.void,
          ),
        }),
      ),
    );
  }),
);

const EASYTIER_MOBILE_POLL_INTERVAL = "5 seconds";
const EASYTIER_MOBILE_TOKEN_REFRESH_SKEW_MS = 60_000;

interface CachedMobilePeerRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
  readonly expiresAtEpochMs?: number;
}

const layerProvidedConnectionStorage = ConnectionStorage.layer.pipe(Layer.provide(Runtime.layer));
const layerProvidedCapabilities = layerCapabilities.pipe(Layer.provide(Runtime.layer));

/**
 * Automatically discovers every EasyTier mesh machine behind any saved Public Gateway
 * (or direct EasyTier host) on Mobile, routing traffic through `/mesh/<environmentId>/`
 * with the saved gateway bearer token — zero manual pairing per machine.
 */
const layerPlatformConnectionSource = Layer.effect(
  PlatformConnectionSource.PlatformConnectionSource,
  Effect.gen(function* () {
    const targetStore = yield* Persistence.ConnectionTargetStore;
    const profileStore = yield* ProfileStore.ConnectionProfileStore;
    const credentialStore = yield* CredentialStore.ConnectionCredentialStore;
    const cacheRef = yield* Ref.make(new Map<string, CachedMobilePeerRegistration>());
    const clientMetadata = authClientMetadata(Constants.expoConfig?.version);

    const buildMobileEasyTierRegistrations = Effect.gen(function* () {
      const savedTargets = yield* targetStore.list.pipe(Effect.orElseSucceed(() => []));
      const savedEnvironmentIds = new Set(savedTargets.map((target) => target.environmentId));
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedMobilePeerRegistration>();
      const registrations: Array<PlatformConnectionRegistration> = [];
      const emittedEnvironmentIds = new Set<string>(savedEnvironmentIds);
      const nowMs = yield* Clock.currentTimeMillis;

      for (const target of savedTargets) {
        if (target._tag !== "BearerConnectionTarget") continue;
        const profileOpt = yield* profileStore
          .get(target.connectionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(profileOpt) || profileOpt.value._tag !== "BearerConnectionProfile") {
          continue;
        }
        const profile = profileOpt.value;
        // Skip proxied `/mesh/<id>/` profiles; only query top-level gateways / hosts.
        if (profile.httpBaseUrl.includes("/mesh/")) continue;

        const credentialOpt = yield* credentialStore
          .get(target.connectionId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isNone(credentialOpt) ||
          credentialOpt.value._tag !== "BearerConnectionCredential"
        ) {
          continue;
        }
        const gatewayToken = credentialOpt.value.token;

        const statusOpt = yield* fetchEasyTierMeshStatus({
          httpBaseUrl: profile.httpBaseUrl,
          bearerToken: gatewayToken,
          timeoutMs: 5_000,
        }).pipe(Effect.option);

        if (Option.isNone(statusOpt) || !statusOpt.value.enabled) continue;
        const status = statusOpt.value;

        for (const peer of status.peers) {
          if (!peer.online || emittedEnvironmentIds.has(peer.environmentId)) continue;
          emittedEnvironmentIds.add(peer.environmentId);

          if (status.preferGatewayProxy && peer.gatewayHttpBaseUrl && peer.gatewayWsBaseUrl) {
            const cacheKey = `easytier-gateway:${peer.environmentId}`;
            const signature = `gateway|${peer.gatewayHttpBaseUrl}|${peer.gatewayWsBaseUrl}|${peer.label}|${gatewayToken}`;
            const cached = previous.get(cacheKey);
            if (cached !== undefined && cached.signature === signature) {
              next.set(cacheKey, cached);
              registrations.push(cached.registration);
              continue;
            }
            const registration = new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                environmentId: peer.environmentId,
                label: peer.label,
                connectionId: cacheKey,
              }),
              profile: new BearerConnectionProfile({
                connectionId: cacheKey,
                environmentId: peer.environmentId,
                label: peer.label,
                httpBaseUrl: peer.gatewayHttpBaseUrl,
                wsBaseUrl: peer.gatewayWsBaseUrl,
                network: "gateway",
              }),
              credential: new BearerConnectionCredential({ token: gatewayToken }),
            });
            next.set(cacheKey, { signature, registration });
            registrations.push(registration);
            continue;
          }

          // Phone is directly inside EasyTier mesh -> obtain zero-pairing peer session directly.
          const cacheKey = `easytier:${peer.environmentId}`;
          const signature = `easytier|${peer.httpBaseUrl}|${peer.wsBaseUrl}|${peer.label}`;
          const cached = previous.get(cacheKey);
          if (
            cached !== undefined &&
            cached.signature === signature &&
            (cached.expiresAtEpochMs === undefined ||
              cached.expiresAtEpochMs - EASYTIER_MOBILE_TOKEN_REFRESH_SKEW_MS > nowMs)
          ) {
            next.set(cacheKey, cached);
            registrations.push(cached.registration);
            continue;
          }
          const accessOpt = yield* bootstrapEasyTierMeshSession({
            httpBaseUrl: peer.httpBaseUrl,
            clientMetadata,
            timeoutMs: 5_000,
          }).pipe(Effect.option);
          if (Option.isSome(accessOpt)) {
            const registration = new BearerConnectionRegistration({
              target: new BearerConnectionTarget({
                environmentId: peer.environmentId,
                label: peer.label,
                connectionId: cacheKey,
              }),
              profile: new BearerConnectionProfile({
                connectionId: cacheKey,
                environmentId: peer.environmentId,
                label: peer.label,
                httpBaseUrl: peer.httpBaseUrl,
                wsBaseUrl: peer.wsBaseUrl,
                network: "easytier",
              }),
              credential: new BearerConnectionCredential({ token: accessOpt.value.access_token }),
            });
            next.set(cacheKey, {
              signature,
              registration,
              expiresAtEpochMs: nowMs + accessOpt.value.expires_in * 1_000,
            });
            registrations.push(registration);
          } else if (
            cached !== undefined &&
            cached.signature === signature &&
            (cached.expiresAtEpochMs === undefined || cached.expiresAtEpochMs > nowMs)
          ) {
            next.set(cacheKey, cached);
            registrations.push(cached.registration);
          }
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations as ReadonlyArray<PlatformConnectionRegistration>;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: Stream.concat(
        Stream.make(undefined),
        Stream.tick(EASYTIER_MOBILE_POLL_INTERVAL),
      ).pipe(Stream.mapEffect(() => buildMobileEasyTierRegistrations)),
    });
  }),
).pipe(Layer.provide(layerProvidedConnectionStorage));

type ConnectionPlatformLayerSource =
  | typeof layerProvidedConnectionStorage
  | typeof Runtime.layer
  | typeof layerConnectivity
  | typeof layerWakeups
  | typeof layerProvidedCapabilities
  | typeof layerPlatformConnectionSource
  | typeof EnvironmentOwnedDataCleanup.layer;

export const layer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  layerProvidedConnectionStorage,
  Runtime.layer,
  layerConnectivity,
  layerWakeups,
  layerProvidedCapabilities,
  layerPlatformConnectionSource,
  EnvironmentOwnedDataCleanup.layer,
);
