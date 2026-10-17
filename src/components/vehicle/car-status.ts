// What the Car screen says about the car (UI-SPEC §7.2): does it answer, and where its speed comes from.
import type { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import type { CanShadowStatus } from "@/obd/can-shadow";
import type { CanOff, EngineState, SpeedSample } from "@/obd/types";
import type { CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";

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
 * monitor stopped, or the ids for the car not found yet (§16.4).
 */
export function speedFromText(
  s: {
    wheelSpeed: boolean;
    speed: SpeedSample | null;
    canOff: CanOff | null;
    canShadow: CanShadowStatus | null;
    canAuto: CanAutoStatus;
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
