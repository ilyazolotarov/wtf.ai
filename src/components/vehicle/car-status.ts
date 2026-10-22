// What the Car screen says about the car (UI-SPEC §7.2): does it answer, and where its speed comes from.
import type { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import type { CanShadowStatus } from "@/obd/can-shadow";
import type { CanOff, EngineState, SpeedSample } from "@/obd/types";
import type { CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";
import type { CanDiscoveryStatus } from "@/services/vehicle-link/can-discovery";
import type { CanProbationStatus } from "@/services/vehicle-link/can-probation";

type Translate = (key: keyof Strings) => string;

/** The car's state while the adapter is connected, coloured: running or awake ok, off plain, not answering yet warn. */
export function carStateText(engine: EngineState, palette: ReturnType<typeof usePalette>, t: Translate): { text: string; color: string } {
  switch (engine) {
    case "engine-running":
      return { text: t("carRunning"), color: palette.ok.c };
    case "engine-off":
      return { text: t("carEngineOff"), color: palette.ok.c };
    case "ignition-off":
      return { text: t("carIgnitionOff"), color: palette.text2 };
    case "unknown":
      return { text: t("carWaiting"), color: palette.warn.c };
  }
}

/**
 * The wheels (VEHICLE-LINK-SPEC §16.3), or OBD and why not the wheels: the setting, the adapter or the car, the
 * profile on probation or failed it (§16.5), the search for a car without a profile (§16.6), the monitor stopped, or
 * the ids for the car not found yet (§16.4).
 */
export function speedFromText(
  s: {
    wheelSpeed: boolean;
    speed: SpeedSample | null;
    canOff: CanOff | null;
    canShadow: CanShadowStatus | null;
    canAuto: CanAutoStatus;
    canProbation?: CanProbationStatus;
    canDiscovery?: CanDiscoveryStatus;
  },
  t: Translate,
): string {
  if (s.wheelSpeed && s.speed?.source === "can") return t("speedFromWheels");
  const why: keyof Strings = !s.wheelSpeed
    ? "wheelsOffSetting"
    : s.canOff === "adapter"
      ? "wheelsNoAdapter"
      : s.canOff === "car"
        ? "wheelsNotCan"
        : s.canOff === "firmware"
          ? "wheelsFroze"
          : s.canShadow?.state === "failed"
            ? "wheelsStopped"
            : s.canProbation?.state === "checking"
              ? "wheelsChecking"
              : s.canProbation?.state === "failed"
                ? "wheelsMismatch"
                : s.canProbation?.state === "aborted" || s.canDiscovery?.state === "aborted"
                  ? "wheelsCheckSlow"
                  : s.canDiscovery?.state === "waiting" || s.canDiscovery?.state === "surveying" || s.canDiscovery?.state === "searching"
                    ? "wheelsSearching"
                    : s.canDiscovery?.state === "none"
                      ? "wheelsNoneOnBus"
                      : s.canAuto.state === "no-vin"
                        ? "wheelsNoVin"
                        : s.canAuto.state === "unknown-make"
                          ? "wheelsUnknownCar"
                          : s.canAuto.state === "probing"
                            ? "wheelsLooking"
                            : s.canAuto.state === "none"
                              ? "wheelsNotHeard"
                              : "wheelsWaiting";
  return `OBD · ${t(why)}`;
}
