import type {
  DesktopDataDirectoryMode,
  DesktopDataDirectoryState,
} from "@t3tools/contracts";
import { FolderOpenIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { T, useGT, Var } from "gt-react";

import { formatBytes } from "../../lib/formatBytes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type PendingAction =
  | { readonly mode: "migrate"; readonly targetBaseDir: string; readonly deleteSource: boolean }
  | { readonly mode: "switch"; readonly targetBaseDir: string }
  | { readonly mode: "reset" };

export function DataDirectorySettingsSection() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const bridge = window.desktopBridge;
  const supported =
    bridge?.getDataDirectoryState !== undefined && bridge?.migrateDataDirectory !== undefined;

  const [state, setState] = useState<DesktopDataDirectoryState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [targetPath, setTargetPath] = useState("");
  const [deleteSource, setDeleteSource] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [targetHadExistingData, setTargetHadExistingData] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads main-process user data directory state over Electron IPC on mount.
  useEffect(() => {
    if (!supported || !bridge?.getDataDirectoryState) return;
    let cancelled = false;
    void bridge
      .getDataDirectoryState()
      .then((nextState) => {
        if (cancelled) return;
        setState(nextState);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, bridge]);

  if (!supported) return null;

  const browseFolder = async () => {
    if (!bridge?.pickFolder) return;
    const initialPath = targetPath.trim() || state?.currentBaseDir || null;
    const picked = await bridge.pickFolder({ initialPath });
    if (picked) {
      setTargetPath(picked);
      setErrorMessage(null);
      setTargetHadExistingData(false);
    }
  };

  const openCurrentFolder = async () => {
    if (!bridge?.openDataDirectory) return;
    const opened = await bridge.openDataDirectory();
    if (!opened) {
      toastManager.add({
        type: "error",
        title: gt("Could not open folder"),
        description: state?.currentBaseDir ?? "",
      });
    }
  };

  const runAction = async (action: PendingAction) => {
    if (!bridge?.migrateDataDirectory || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    setTargetHadExistingData(false);
    try {
      const result = await bridge.migrateDataDirectory(
        action.mode === "migrate"
          ? {
              mode: "migrate",
              targetBaseDir: action.targetBaseDir,
              deleteSource: action.deleteSource,
            }
          : action.mode === "switch"
            ? {
                mode: "switch",
                targetBaseDir: action.targetBaseDir,
              }
            : {
                mode: "reset",
              },
      );
      if (!result.ok) {
        setErrorMessage(result.error ?? gt("Data directory operation failed."));
        setTargetHadExistingData(result.targetHadExistingData === true);
        setPendingAction(null);
        return;
      }
      setPendingAction(null);
      toastManager.add({
        type: "success",
        title: result.relaunching
          ? gt("Data directory updated. Restarting Quixotic…")
          : gt("Data directory is already using the default location."),
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPendingAction(null);
    } finally {
      setSubmitting(false);
    }
  };

  const trimmedTarget = targetPath.trim();
  const canSubmitTarget =
    state !== null && !state.overriddenByEnv && trimmedTarget.length > 0 && !submitting;

  const confirmTitle = (mode: DesktopDataDirectoryMode) => {
    if (mode === "migrate") return gt("Migrate user data directory?");
    if (mode === "switch") return gt("Switch to existing data directory?");
    return gt("Reset user data directory to default?");
  };

  return (
    <SettingsSection id="storage-data-directory-section" title={gt("User data directory")} variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...setting("storage-data-directory")}
          description={gt(
            "Conversations, database, settings, caches, and logs. Move to another drive to free system drive space.",
          )}
          control={
            <div className="flex items-center gap-2">
              {bridge?.openDataDirectory && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state === null || submitting}
                  onClick={() => void openCurrentFolder()}
                >
                  <FolderOpenIcon className="size-3.5" />
                  <T>Open folder</T>
                </Button>
              )}
              {state?.isCustom && !state.overriddenByEnv && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setPendingAction({ mode: "reset" })}
                >
                  <RotateCcwIcon className="size-3.5" />
                  <T>Reset to default</T>
                </Button>
              )}
            </div>
          }
        />

        <div className="space-y-3 border-t border-border/60 px-3 py-3 sm:px-4">
          {state ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <code className="rounded bg-muted px-1.5 py-0.5 text-foreground/90 select-text">
                {state.currentBaseDir}
              </code>
              {state.sizeBytes !== null && (
                <span className="text-muted-foreground">{formatBytes(state.sizeBytes)}</span>
              )}
              {state.isCustom && (
                <span className="text-muted-foreground">
                  <T>(Custom location)</T>
                </span>
              )}
            </div>
          ) : loadFailed ? (
            <p className="text-xs text-destructive">
              <T>Could not load the current data directory state.</T>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              <T>Calculating current data folder…</T>
            </p>
          )}

          {state?.overriddenByEnv && (
            <p className="text-xs text-warning">
              <T>
                Overridden by the <Var>{"T3CODE_HOME"}</Var> environment variable. Unset it to
                manage the location here.
              </T>
            </p>
          )}

          {state && !state.overriddenByEnv && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  aria-label={gt("Target user data folder")}
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={gt("Choose a new folder, e.g. D:\\QuixoticData")}
                  value={targetPath}
                  disabled={submitting}
                  onChange={(event) => {
                    setTargetPath(event.target.value);
                    setErrorMessage(null);
                    setTargetHadExistingData(false);
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={submitting}
                  onClick={() => void browseFolder()}
                >
                  <T>Browse…</T>
                </Button>
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={deleteSource}
                  disabled={submitting}
                  onCheckedChange={(checked) => setDeleteSource(checked === true)}
                />
                <span>
                  <T>Delete the old data folder after migration succeeds to free disk space</T>
                </span>
              </label>

              {errorMessage && (
                <p className="text-xs text-destructive" role="alert">
                  {errorMessage}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={!canSubmitTarget}
                  onClick={() =>
                    setPendingAction({
                      mode: "migrate",
                      targetBaseDir: trimmedTarget,
                      deleteSource,
                    })
                  }
                >
                  {submitting ? gt("Migrating…") : gt("Migrate & restart")}
                </Button>
                <Button
                  variant={targetHadExistingData ? "default" : "outline"}
                  size="sm"
                  disabled={!canSubmitTarget}
                  onClick={() =>
                    setPendingAction({
                      mode: "switch",
                      targetBaseDir: trimmedTarget,
                    })
                  }
                >
                  <T>Use existing folder</T>
                </Button>
              </div>
            </>
          )}
        </div>
      </SettingsGroup>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setPendingAction(null);
        }}
      >
        <AlertDialogPopup>
          {pendingAction && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{confirmTitle(pendingAction.mode)}</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingAction.mode === "migrate" ? (
                    <span className="block space-y-2">
                      <span className="block">
                        <T>
                          Quixotic will stop local background services, copy your data from{" "}
                          <Var>{state?.currentBaseDir ?? ""}</Var> to{" "}
                          <Var>{pendingAction.targetBaseDir}</Var>, verify the copied database, and
                          restart automatically.
                        </T>
                      </span>
                      {pendingAction.deleteSource ? (
                        <span className="block text-warning">
                          <T>
                            After verification succeeds, the old folder will be deleted to free disk
                            space.
                          </T>
                        </span>
                      ) : (
                        <span className="block">
                          <T>
                            The old folder will be kept as a backup until you delete it manually.
                          </T>
                        </span>
                      )}
                    </span>
                  ) : pendingAction.mode === "switch" ? (
                    <T>
                      Quixotic will stop local background services, switch directly to{" "}
                      <Var>{pendingAction.targetBaseDir}</Var> without copying files, and restart
                      automatically.
                    </T>
                  ) : (
                    <T>
                      Quixotic will stop local background services, switch back to the default
                      location <Var>{state?.defaultBaseDir ?? ""}</Var>, and restart automatically.
                    </T>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" disabled={submitting} />}>
                  <T>Cancel</T>
                </AlertDialogClose>
                <Button
                  disabled={submitting}
                  onClick={() => void runAction(pendingAction)}
                >
                  {submitting
                    ? gt("Working…")
                    : pendingAction.mode === "migrate"
                      ? gt("Migrate & restart")
                      : pendingAction.mode === "switch"
                        ? gt("Switch & restart")
                        : gt("Reset & restart")}
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
