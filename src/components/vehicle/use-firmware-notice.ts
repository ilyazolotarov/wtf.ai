import { router } from "expo-router";
import { useEffect } from "react";

import { useRuntime, useVehicleLinkValue } from "@/providers/runtime-provider";
import { MOVING_MPS } from "@/services/app-update/decide";
import { firmwareNoticeDue, markFirmwareAsked } from "@/services/vehicle-link/firmware-notice";

/**
 * Opens the firmware check (`adapter-firmware`) the first time an adapter answers on this phone, over whatever is on
 * screen: onboarding's Car page too. Never while the car moves: a first connect on the road waits for a stop.
 */
export function useFirmwareNotice(): void {
  const { link } = useRuntime();
  const deviceId = useVehicleLinkValue((s) => s.adapter?.deviceId ?? null);
  const moving = useVehicleLinkValue((s) => (s.lastSpeed?.speedMps ?? 0) > MOVING_MPS);

  useEffect(() => {
    const adapter = link.getSnapshot().adapter;
    if (!deviceId || moving || adapter?.deviceId !== deviceId) return;
    const updater = firmwareNoticeDue(adapter);
    if (!updater) return;
    markFirmwareAsked(deviceId);
    router.push({ pathname: "/adapter-firmware", params: { updater, adapter: adapter.name ?? "" } });
  }, [link, deviceId, moving]);
}
