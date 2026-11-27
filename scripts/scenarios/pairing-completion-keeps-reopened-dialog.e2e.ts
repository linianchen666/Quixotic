import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Finishing an EasyTier pairing leaves a newly opened phone pairing dialog open",
  WEB,
  async ({ t3, app, browser, screen }) => {
    await t3.project("demo");
    await t3.open("/settings/connections");
    const advanced = screen.getByRole("button", "Advanced environment settings");
    const mapSearch = screen.getByRole("searchbox", "Find a machine on the map");
    await advanced.waitFor({ state: "visible" });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(mapSearch).not.toBeVisible();
    await advanced.tap();
    await expect(advanced).toHaveAttribute("aria-expanded", "true");
    await expect(mapSearch).toBeVisible();
    await app.screenshot("advanced-environments");
    const pairingToken = "**/api/auth/pairing-token";
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await browser.route(pairingToken, async (route) => {
      if (route.request.method !== "POST") return route.fallback();
      requested.resolve();
      await release.promise;
      await route.continue();
    });

    await screen.getByRole("button", "Sharing & access", { exact: true }).tap();
    const authorizedClients = browser.locator("#authorized-clients");
    const authorizedClientsToggle = authorizedClients.getByRole("button", "Authorized clients", {
      exact: false,
    });
    await authorizedClientsToggle.waitFor({ state: "visible" });
    await expect(authorizedClientsToggle).toHaveAttribute("aria-expanded", "true");
    const easyTier = "Pair an EasyTier computer";
    const phone = "Pair a phone";
    const openEasyTier = authorizedClients.getByRole("button", easyTier, { exact: true });
    const openPhone = authorizedClients.getByRole("button", phone, { exact: true });
    const dialog = screen.getByRole("dialog", easyTier, { exact: true });
    const phoneDialog = screen.getByRole("dialog", phone, { exact: true });
    // A closing popup keeps its role until its exit animation ends; only an open one has data-open.
    const openDialog = browser
      .locator('[data-slot="dialog-popup"][data-open]')
      .getByRole("heading", phone, { exact: true });
    const label = "Waiting tablet";
    try {
      await openEasyTier.tap();
      await dialog
        .getByRole("textbox", "EasyTier address", { exact: true })
        .fill("10.126.126.20:3773");
      await dialog.getByText("Client label and permissions", { exact: true }).tap();
      await dialog.getByPlaceholder("e.g. Living room iPad").fill(label);
      await dialog.getByRole("button", "Generate pairing QR code", { exact: true }).tap();
      await requested.promise;
      await browser.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await openPhone.tap();
      await openDialog.waitFor();

      release.resolve();
      await authorizedClients.getByText(label, { exact: true }).waitFor();
      await app.screenshot("after-first-link-finishes");
      await expect(openDialog).toBeVisible();
      await expect(
        phoneDialog.getByRole("textbox", "Public HTTPS domain", { exact: true }),
      ).toBeVisible();
      await expect(
        phoneDialog.getByRole("img", "Pairing link. Scan to open on another device"),
      ).not.toBeVisible();
    } finally {
      release.resolve();
      await browser.unroute(pairingToken);
    }
  },
);
