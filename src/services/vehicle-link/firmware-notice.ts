import { Linking, Platform } from "react-native";

import { firmwareUpdaterFor, type FirmwareUpdater } from "@/obd/catalog";
import type { AdapterInfo } from "@/obd/types";
import { kvStore } from "@/services/kv-store";

/**
 * The firmware check (VEHICLE-LINK-SPEC §8.4): an adapter new to this phone may have waited on a shelf for months, so
 * the first time it answers, the driver is asked to look for a firmware update in its maker's app. Once per adapter:
 * after that the driver knows it can be updated.
 */
const ASKED_KEY = "adapter-firmware-asked";

/** The updater in the store: its App Store id, its Google Play package. */
const STORE_IDS: Record<FirmwareUpdater, { ios: string; android: string }> = {
  obdlink: { ios: "879636351", android: "OCTech.Mobile.Applications.OBDLink" },
  vgate: { ios: "1613129761", android: "tm.vlinker.VgateFwUpdater" },
};

function asked(): string[] {
  return kvStore.getJson<string[]>(ASKED_KEY) ?? [];
}

/** The updater to ask about for this adapter; null: asked before, or no maker's app for it. */
export function firmwareNoticeDue(
  adapter: Pick<AdapterInfo, "deviceId" | "name">,
): FirmwareUpdater | null {
  const updater = firmwareUpdaterFor({
    id: adapter.deviceId,
    name: adapter.name,
  });
  return updater && !asked().includes(adapter.deviceId) ? updater : null;
}

export function markFirmwareAsked(deviceId: string): void {
  const list = asked();
  if (!list.includes(deviceId)) kvStore.setJson(ASKED_KEY, [...list, deviceId]);
}

/** Developer: every adapter is new again. */
export function resetFirmwareAsked(): void {
  kvStore.setJson(ASKED_KEY, []);
}

/**
 * Auto-connect paused while the maker's app updates the adapter: an adapter answers one app at a time, and the app
 * coming back to the front (the driver rereading the steps) would take it back mid-update. Ends with the page's
 * "Connect again", the page closing, the driver's own Connect, or after `HOLD_MS` (a page forgotten open must not
 * leave a drive without the adapter); in memory, so a restarted app connects as usual.
 */
const HOLD_MS = 30 * 60_000;
let heldUntil = 0;

export function holdForUpdater(): void {
  heldUntil = Date.now() + HOLD_MS;
}

export function releaseUpdaterHold(): void {
  heldUntil = 0;
}

export function isHeldForUpdater(): boolean {
  return Date.now() < heldUntil;
}

/**
 * The updater's page in the store app (App Store, Google Play), where it shows Open once installed; the web page
 * where there is no store app (an emulator without Google Play).
 */
export async function openUpdaterStore(updater: FirmwareUpdater): Promise<void> {
  const { ios, android } = STORE_IDS[updater];
  const [app, web] =
    Platform.OS === "ios"
      ? [`itms-apps://apps.apple.com/app/id${ios}`, `https://apps.apple.com/app/id${ios}`]
      : [`market://details?id=${android}`, `https://play.google.com/store/apps/details?id=${android}`];
  try {
    await Linking.openURL(app);
  } catch {
    await Linking.openURL(web);
  }
}
