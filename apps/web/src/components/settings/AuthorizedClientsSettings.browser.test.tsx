import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  type DevicePairingAddressKind,
  type ServerSettingsPatch,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { AuthorizedClientsHeaderAction } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
  createCredential: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.createCredential) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (environmentId) => (patch, options) => {
    state.saveSettings(environmentId, patch);
    options?.onSaved?.();
  },
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
  state.createCredential.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { credential: "test-pairing-credential" },
  });
  state.saveSettings.mockReset();
}

const renderHeader = (
  environmentId: EnvironmentId,
  addresses?: Readonly<Record<DevicePairingAddressKind, string>>,
) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={[AuthOrchestrationReadScope]}
      {...(addresses ? { devicePairingAddresses: addresses } : {})}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });

  it.each([
    {
      action: "Pair an EasyTier computer",
      label: "EasyTier address",
      saved: "",
      address: "10.126.126.20:3773",
      invalid: "http://127.0.0.1:3773",
      origin: "http://10.126.126.20:3773",
      patch: { easyTierPairingAddress: "http://10.126.126.20:3773" },
    },
    {
      action: "Pair a phone",
      label: "Public gateway address",
      saved: "https://linux.example.com",
      address: "203.0.113.10:3773",
      invalid: "http://127.0.0.1:3773",
      origin: "http://203.0.113.10:3773",
      patch: { publicPairingAddress: "http://203.0.113.10:3773" },
    },
  ] satisfies ReadonlyArray<{
    action: string;
    label: string;
    saved: string;
    address: string;
    invalid: string;
    origin: string;
    patch: ServerSettingsPatch;
  }>)(
    "saves the selected environment's address and generates the matching link for $action",
    async ({ action, label, saved, address, invalid, origin, patch }) => {
      setup([]);
      await using screen = await renderHeader(serviceId, {
        easyTier: action === "Pair an EasyTier computer" ? saved : "http://10.126.126.99:3773",
        public: action === "Pair a phone" ? saved : "https://other.example.com",
      });

      await screen.getByRole("button", { name: action }).click();
      const field = screen.getByRole("textbox", { name: label });
      const generate = screen.getByRole("button", { name: "Generate pairing QR code" });
      await expect.element(field).toHaveValue(saved);
      await field.fill(invalid);
      await expect.element(generate).toBeDisabled();
      await field.fill(address);
      await generate.click();

      expect(state.saveSettings).toHaveBeenCalledExactlyOnceWith(serviceId, patch);
      expect(state.createCredential).toHaveBeenCalledExactlyOnceWith({
        environmentId: serviceId,
        input: { scopes: [AuthOrchestrationReadScope] },
      });
      await expect
        .element(screen.getByRole("textbox", { name: "Pairing link" }))
        .toHaveValue(`${origin}/pair#token=test-pairing-credential`);
      await expect
        .element(screen.getByRole("img", { name: "Pairing link. Scan to open on another device" }))
        .toBeVisible();
    },
  );
});
