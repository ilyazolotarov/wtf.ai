// What the Car screen says about the car (UI-SPEC §7.2): does it answer, and where its speed comes from.
import type { usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import type { CanOff, EngineState } from "@/obd/types";

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
 * Where the speed comes from: the car's data bus (VEHICLE-LINK-SPEC §16.3) or OBD, and why not the bus only when the
 * driver can do something about it (the adapter froze reading it: its firmware). The other reasons (the setting, a
 * plain ELM327, a car without CAN at the port, the profile's probation, the search, the ids) are the app's own steps,
 * which drivers read as faults ("my adapter does support the wheels"): they are in the trip log, not here.
 */
export function speedFromText(
  s: {
    wheelSpeed: boolean;
    /** The snapshot's `speedFromCan`. */
    speedFromCan: boolean;
    canOff: CanOff | null;
  },
  t: Translate,
): string {
  if (s.wheelSpeed && s.speedFromCan) return t("speedFromWheels");
  return s.wheelSpeed && s.canOff === "firmware" ? `OBD · ${t("wheelsFroze")}` : "OBD";
}
