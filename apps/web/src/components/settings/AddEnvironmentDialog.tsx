import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT } from "gt-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  connectGatewayOrEasyTier as connectGatewayOrEasyTierAtom,
  connectPairing as connectPairingAtom,
} from "~/connection/onboarding";
import { type EnvironmentPresentation } from "~/state/environments";
import type { AddEnvironmentPrefill } from "~/state/linkedThreadView";
import { useAtomCommand } from "../../state/use-atom-command";
import { parsePairingUrlFields } from "./ConnectionsSettings.logic";

export function AddEnvironmentDialog({
  open,
  prefill = null,
  routeTarget,
  error,
  initialHost = "",
  onOpenChange,
  onErrorChange,
}: {
  readonly open: boolean;
  /** A machine the user chose elsewhere to connect to. */
  readonly prefill?: AddEnvironmentPrefill | null;
  readonly routeTarget: EnvironmentPresentation | null;
  /** An address already known for the machine being added, such as one a link uses. */
  readonly initialHost?: string;
  readonly error: string | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onErrorChange: (error: string | null) => void;
}) {
  const gt = useGT();
  const connectGatewayOrEasyTier = useAtomCommand(connectGatewayOrEasyTierAtom, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const [hostInput, setHostInput] = useState(prefill?.host ?? initialHost);
  const [passwordInput, setPasswordInput] = useState("");
  const [pastedPairingCode, setPastedPairingCode] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setHostInput(initialHost);
      setPasswordInput("");
      setPastedPairingCode(null);
      onErrorChange(null);
    }
    onOpenChange(nextOpen);
  };

  const handleHostChange = (value: string) => {
    const parsedPairingUrl = parsePairingUrlFields(value);
    if (parsedPairingUrl) {
      setHostInput(parsedPairingUrl.host);
      setPastedPairingCode(parsedPairingUrl.pairingCode);
      setPasswordInput("");
      return;
    }
    setPastedPairingCode(null);
    setHostInput(value);
  };

  const handleAddSavedBackend = async () => {
    const host = hostInput.trim();
    if (!host) {
      onErrorChange(gt("Enter a gateway or EasyTier address."));
      return;
    }

    setIsAddingSavedBackend(true);
    onErrorChange(null);

    const expected = routeTarget ?? prefill;
    const result =
      pastedPairingCode !== null
        ? await connectPairing({
            host,
            pairingCode: pastedPairingCode,
            ...(expected ? { expectedEnvironmentId: expected.environmentId } : {}),
          })
        : await connectGatewayOrEasyTier({
            host,
            ...(passwordInput.trim().length > 0 ? { password: passwordInput.trim() } : {}),
            ...(expected ? { expectedEnvironmentId: expected.environmentId } : {}),
          });

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        const message =
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : gt("Failed to add environment.");
        onErrorChange(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not add environment"),
            description: message,
          }),
        );
      }
      setIsAddingSavedBackend(false);
      return;
    }

    handleOpenChange(false);
    toastManager.add(
      routeTarget
        ? {
            type: "success",
            title: gt("Route added"),
            description: gt("{environment} now has another way to connect.", {
              environment: routeTarget.label,
            }),
          }
        : {
            type: "success",
            title: gt("Environment connected"),
            description: gt("The environment is saved and will reconnect automatically."),
          },
    );
    setIsAddingSavedBackend(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button size="xs" variant="ghost-muted" aria-label={gt("Add environment")}>
                  <PlusIcon className="size-3" />
                  <span>
                    <T>Add environment</T>
                  </span>
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">
          <T>Add environment</T>
        </TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-h-[80dvh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {routeTarget
              ? gt("Add a route to {environment}", { environment: routeTarget.label })
              : prefill
                ? gt("Connect to {environment}", { environment: prefill.label })
                : gt("Connect via EasyTier or Public Gateway")}
          </DialogTitle>
          <DialogDescription>
            {routeTarget
              ? gt(
                  "Add an EasyTier or public gateway address for this machine. It joins the existing routes instead of adding a second machine.",
                )
              : gt(
                  "Machines on your EasyTier subnet appear automatically. You can also enter an EasyTier node address (no password needed) or a Public Gateway IP and password.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  <T>Server address</T>
                </span>
                <Input
                  value={hostInput}
                  onChange={(event) => handleHostChange(event.target.value)}
                  placeholder="203.0.113.10:3773"
                  disabled={isAddingSavedBackend}
                  spellCheck={false}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  <T>Gateway access password (optional)</T>
                </span>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={passwordInput}
                  onChange={(event) => {
                    setPastedPairingCode(null);
                    setPasswordInput(event.target.value);
                  }}
                  placeholder={gt("Leave blank for direct EasyTier node")}
                  disabled={isAddingSavedBackend}
                  spellCheck={false}
                />
              </label>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button
              variant="outline"
              className="w-full"
              disabled={isAddingSavedBackend || hostInput.trim().length === 0}
              onClick={() => void handleAddSavedBackend()}
            >
              <PlusIcon className="size-3.5" />
              {isAddingSavedBackend
                ? gt("Connecting…")
                : routeTarget
                  ? gt("Add route")
                  : gt("Connect")}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
