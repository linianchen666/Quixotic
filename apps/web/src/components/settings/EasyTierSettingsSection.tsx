import {
  fetchEasyTierMeshStatus,
  refreshEasyTierMeshStatus,
  updateEasyTierGatewayPassword,
} from "@t3tools/client-runtime/authorization";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import {
  normalizeDevicePairingAddress,
  type EasyTierMeshStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { usePreparedConnection } from "~/state/session";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function makeEasyTierHttpLayer(bearerToken: string | undefined) {
  return Layer.merge(
    layerRemoteHttpClient(globalThis.fetch),
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: bearerToken ? "omit" : "include",
    }),
  );
}

function extractBearerToken(
  httpAuthorization: PreparedHttpAuthorization | null,
): string | undefined {
  return httpAuthorization?._tag === "Bearer" ? httpAuthorization.token : undefined;
}

export function EasyTierSettingsSection({
  environmentId,
  canWriteAccess,
  publicPairingAddress,
  onSavePublicGatewayAddress,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWriteAccess: boolean;
  readonly publicPairingAddress?: string;
  readonly onSavePublicGatewayAddress?: (address: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const preparedOption = usePreparedConnection(environmentId);
  const prepared = preparedOption._tag === "Some" ? preparedOption.value : null;
  const httpBaseUrl = prepared?.httpBaseUrl ?? null;
  const bearerToken = extractBearerToken(prepared?.httpAuthorization ?? null);

  const [status, setStatus] = useState<EasyTierMeshStatus | null>(null);
  const [loadedBaseUrl, setLoadedBaseUrl] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gatewayPasswordInput, setGatewayPasswordInput] = useState("");
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [gatewayAddressInput, setGatewayAddressInput] = useState(publicPairingAddress ?? "");
  const isLoading = httpBaseUrl !== null && loadedBaseUrl !== httpBaseUrl;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches EasyTier mesh status for the selected environment when its connection changes
  useEffect(() => {
    if (!httpBaseUrl) return;
    let cancelled = false;
    void Effect.runPromise(
      fetchEasyTierMeshStatus({
        httpBaseUrl,
        ...(bearerToken ? { bearerToken } : {}),
        timeoutMs: 8_000,
      }).pipe(Effect.provide(makeEasyTierHttpLayer(bearerToken))),
    )
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setError(null);
        setLoadedBaseUrl(httpBaseUrl);
        if (next.publicGatewayUrl && !publicPairingAddress) {
          setGatewayAddressInput(next.publicGatewayUrl);
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? (thrownErrorMessage(cause, m) ?? cause.message)
            : gt("Could not load EasyTier status."),
        );
        setLoadedBaseUrl(httpBaseUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [bearerToken, gt, httpBaseUrl, m, publicPairingAddress]);

  const handleScanNow = async () => {
    if (!httpBaseUrl || isScanning) return;
    setIsScanning(true);
    setError(null);
    try {
      const next = await Effect.runPromise(
        refreshEasyTierMeshStatus({
          httpBaseUrl,
          ...(bearerToken ? { bearerToken } : {}),
          timeoutMs: 12_000,
        }).pipe(Effect.provide(makeEasyTierHttpLayer(bearerToken))),
      );
      setStatus(next);
      toastManager.add({
        type: "success",
        title: gt("EasyTier scan complete"),
        description:
          next.peers.length === 0
            ? gt("No other Quixotic nodes found on the EasyTier subnet.")
            : gt("{count, plural, one {Found {count} EasyTier node.} other {Found {count} EasyTier nodes.}}", {
                count: next.peers.length,
              }),
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Could not scan EasyTier peers.");
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("EasyTier scan failed"),
          description: message,
        }),
      );
    } finally {
      setIsScanning(false);
    }
  };

  const handleSaveGatewayPassword = async (password: string | null) => {
    if (!httpBaseUrl || isSavingPassword) return;
    setIsSavingPassword(true);
    try {
      const result = await Effect.runPromise(
        updateEasyTierGatewayPassword({
          httpBaseUrl,
          ...(bearerToken ? { bearerToken } : {}),
          password,
          timeoutMs: 8_000,
        }).pipe(Effect.provide(makeEasyTierHttpLayer(bearerToken))),
      );
      setGatewayPasswordInput("");
      setStatus((current) =>
        current
          ? {
              ...current,
              gatewayPasswordConfigured: result.configured,
              gatewayMode: result.configured || current.gatewayMode,
            }
          : current,
      );
      toastManager.add({
        type: "success",
        title: result.configured
          ? gt("Gateway access password saved")
          : gt("Gateway access password cleared"),
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? (thrownErrorMessage(cause, m) ?? cause.message)
          : gt("Could not update gateway password.");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update gateway password"),
          description: message,
        }),
      );
    } finally {
      setIsSavingPassword(false);
    }
  };

  const trimmedGatewayAddress = gatewayAddressInput.trim();
  const normalizedGatewayAddress =
    trimmedGatewayAddress.length === 0
      ? ""
      : normalizeDevicePairingAddress("public", trimmedGatewayAddress);
  const isGatewayAddressValid =
    trimmedGatewayAddress.length === 0 || normalizedGatewayAddress !== null;
  const gatewayAddressChanged =
    isGatewayAddressValid &&
    (normalizedGatewayAddress ?? "") !== (publicPairingAddress?.trim() ?? "");

  const onlinePeerCount = status?.peers.filter((peer) => peer.online).length ?? 0;

  return (
    <SettingsSection
      {...searchableSetting("easytier-mesh")}
      title={gt("EasyTier & Public Gateway")}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!httpBaseUrl || isScanning || isLoading}
          onClick={() => void handleScanNow()}
        >
          {isScanning ? <Spinner size="sm" /> : <RefreshCwIcon className="size-3" />}
          <span>{isScanning ? gt("Scanning…") : gt("Scan now")}</span>
        </Button>
      }
    >
      <SettingsRow
        title={gt("EasyTier mesh")}
        description={
          isLoading && status === null ? (
            gt("Checking EasyTier network…")
          ) : status?.localIp ? (
            gt(
              "Connected on {ip} ({cidr}). Machines on the same EasyTier subnet appear automatically in Environments with no pairing.",
              {
                ip: status.localIp,
                cidr: status.cidr ?? status.localIp,
              },
            )
          ) : (
            gt(
              "No EasyTier interface detected yet. Join your EasyTier virtual network on this machine to discover and connect peers automatically.",
            )
          )
        }
        status={error ? <span className="block text-destructive">{error}</span> : null}
        control={
          status?.localIp ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success-foreground">
              <ConnectionStatusDot dotClassName="bg-success" />
              {gt("{count, plural, one {{count} peer online} other {{count} peers online}}", {
                count: onlinePeerCount,
              })}
            </span>
          ) : null
        }
      />

      {status && status.peers.length > 0 ? (
        <div className="divide-y divide-border/50 border-t border-border/50 bg-muted/15 px-3 sm:px-4">
          {status.peers.map((peer) => (
            <div
              key={peer.environmentId}
              className="flex items-center justify-between gap-3 py-2 text-xs"
            >
              <div className="flex min-w-0 items-center gap-2">
                <ConnectionStatusDot
                  dotClassName={peer.online ? "bg-success" : "bg-muted-foreground/40"}
                />
                <span className="truncate font-medium text-foreground">{peer.label}</span>
                <span className="truncate font-mono text-muted-foreground">{peer.easyTierIp}</span>
              </div>
              <span className="shrink-0 text-muted-foreground">
                {peer.online
                  ? peer.latencyMs !== undefined
                    ? `${Math.round(peer.latencyMs)} ms`
                    : gt("Online")
                  : gt("Offline")}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <SettingsRow
        {...searchableSetting("public-gateway")}
        title={gt("Public gateway access")}
        description={
          status?.gatewayPasswordConfigured
            ? gt(
                "Password protection is enabled. Phones and browsers can sign in at this machine's public IP to reach all online EasyTier machines.",
              )
            : gt(
                "Set a gateway access password on your public cloud server so mobile apps and browsers can sign in via public IP and control all EasyTier machines.",
              )
        }
        control={
          status?.gatewayPasswordConfigured ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <ShieldCheckIcon className="size-3.5" />
              <T>Protected</T>
            </span>
          ) : null
        }
      />

      {canWriteAccess ? (
        <div className="space-y-3 border-t border-border/50 px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="password"
              autoComplete="new-password"
              value={gatewayPasswordInput}
              onChange={(event) => setGatewayPasswordInput(event.target.value)}
              placeholder={
                status?.gatewayPasswordConfigured
                  ? gt("Enter new gateway password (min 6 chars)")
                  : gt("Set gateway access password (min 6 chars)")
              }
              disabled={isSavingPassword || !httpBaseUrl}
              className="sm:max-w-sm"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  isSavingPassword || !httpBaseUrl || gatewayPasswordInput.trim().length < 6
                }
                onClick={() => void handleSaveGatewayPassword(gatewayPasswordInput.trim())}
              >
                {isSavingPassword ? <Spinner size="sm" /> : null}
                <span>
                  {status?.gatewayPasswordConfigured ? gt("Update password") : gt("Save password")}
                </span>
              </Button>
              {status?.gatewayPasswordConfigured ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={isSavingPassword || !httpBaseUrl}
                  onClick={() => void handleSaveGatewayPassword(null)}
                >
                  <T>Clear</T>
                </Button>
              ) : null}
            </div>
          </div>

          {onSavePublicGatewayAddress ? (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                <T>Public gateway URL (optional)</T>
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={gatewayAddressInput}
                  onChange={(event) => setGatewayAddressInput(event.target.value)}
                  placeholder="http://203.0.113.10:3773"
                  spellCheck={false}
                  className="sm:max-w-sm"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!gatewayAddressChanged || !isGatewayAddressValid}
                  onClick={() => onSavePublicGatewayAddress(normalizedGatewayAddress ?? "")}
                >
                  <T>Save address</T>
                </Button>
              </div>
              {!isGatewayAddressValid ? (
                <p className="text-xs text-destructive">
                  <T>Enter a public IP or domain using HTTP or HTTPS.</T>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}
