import { speedFromText } from "../car-status";
import type { CanAutoStatus } from "@/services/vehicle-link/can-auto-ids";
import { en } from "@/i18n/en";
import type { SpeedSample } from "@/obd/types";

const t = (key: keyof typeof en) => en[key];
const sample = (can: boolean): SpeedSample => ({ txUs: 0, rxUs: 0, tUs: 0, speedMps: 10, raw: 36, ...(can ? { source: "can" as const } : {}) });
const chosen: CanAutoStatus = { state: "chosen", ids: [0x215], profile: "mazda" };
const base = { wheelSpeed: true, speed: sample(false), canOff: null, canShadow: null, canAuto: chosen };

describe("speedFromText", () => {
  it("the wheels while their speed comes", () => {
    expect(speedFromText({ ...base, speed: sample(true) }, t)).toBe("The wheels");
  });

  it("OBD, and why not the wheels", () => {
    expect(speedFromText({ ...base, wheelSpeed: false, speed: sample(true) }, t)).toBe("OBD · wheels off in Settings");
    expect(speedFromText({ ...base, canOff: "adapter" }, t)).toBe("OBD · this adapter can't read the wheels");
    expect(speedFromText({ ...base, canOff: "car" }, t)).toBe("OBD · the car has no CAN bus");
    expect(speedFromText({ ...base, canShadow: { state: "failed", frames: 0 } as never }, t)).toBe("OBD · reading the wheels stopped");
    expect(speedFromText({ ...base, canAuto: { state: "unknown-make" } }, t)).toBe("OBD · the wheels of this make aren't known");
    expect(speedFromText(base, t)).toBe("OBD · waiting for the wheels");
  });
});
