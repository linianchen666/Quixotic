import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  connectGatewayOrEasyTier: vi.fn<
    (input: { readonly host: string; readonly password?: string }) => Promise<AtomCommandResult<void, Error>>
  >(async () => AsyncResult.success(undefined)),
  connectPairing: vi.fn<
    (input: { readonly host: string; readonly pairingCode: string }) => Promise<AtomCommandResult<void, Error>>
  >(async () => AsyncResult.success(undefined)),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectGatewayOrEasyTier: mocks.connectGatewayOrEasyTier as never,
  connectPairing: mocks.connectPairing as never,
}));

import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

function Owner() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AppAtomRegistryProvider>
      <AddEnvironmentDialog
        open={open}
        routeTarget={null}
        error={error}
        savedEnvironments={[]}
        onOpenChange={setOpen}
        onErrorChange={setError}
      />
    </AppAtomRegistryProvider>
  );
}

describe("AddEnvironmentDialog", () => {
  it("connects to a Public Gateway with password and clears inputs after close", async () => {
    mocks.connectGatewayOrEasyTier.mockClear();
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("203.0.113.10:3773"), "203.0.113.10:3773");
    await userEvent.fill(
      page.getByPlaceholder("Leave blank for direct EasyTier node"),
      "gateway-secret",
    );
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));

    expect(mocks.connectGatewayOrEasyTier).toHaveBeenCalledExactlyOnceWith({
      host: "203.0.113.10:3773",
      password: "gateway-secret",
    });

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await expect.element(page.getByPlaceholder("203.0.113.10:3773")).toHaveValue("");
    await expect
      .element(page.getByPlaceholder("Leave blank for direct EasyTier node"))
      .toHaveValue("");
  });

  it("shows connection errors and resets them when dismissed", async () => {
    mocks.connectGatewayOrEasyTier.mockReset();
    mocks.connectGatewayOrEasyTier.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Invalid gateway password"))),
    );
    await using _screen = await render(<Owner />);

    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await userEvent.fill(page.getByPlaceholder("203.0.113.10:3773"), "10.126.126.10:3773");
    await userEvent.click(page.getByRole("dialog").getByRole("button", { name: "Connect" }));

    await expect.element(page.getByText(/Invalid gateway password/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Add environment" }));
    await expect.element(page.getByText(/Invalid gateway password/)).not.toBeInTheDocument();
  });
});
