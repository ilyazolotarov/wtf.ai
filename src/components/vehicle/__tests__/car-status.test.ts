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

  it("OBD while the wheels are checked against it, or after they failed (VEHICLE-LINK-SPEC §16.5)", () => {
    const profile = "mazda/mazda/mazda_2017";
    expect(speedFromText({ ...base, canProbation: { state: "checking", profile } }, t)).toBe("OBD · checking the wheels against the OBD speed");
    expect(speedFromText({ ...base, canProbation: { state: "failed", profile, reason: "scale" } }, t)).toBe("OBD · the wheels didn't match the OBD speed");
    expect(speedFromText({ ...base, canProbation: { state: "aborted", profile } }, t)).toBe(
      "OBD · the adapter was too slow to check the wheels on this drive",
    );
    // A car without a profile: its bus searched, or nothing found on it (§16.6).
    expect(speedFromText({ ...base, canAuto: { state: "unknown-make" }, canDiscovery: { state: "searching", tried: 3, of: 12 } }, t)).toBe(
      "OBD · searching the car's bus for its speed",
    );
    expect(speedFromText({ ...base, canAuto: { state: "none", heard: 0 }, canDiscovery: { state: "none" } }, t)).toBe("OBD · no speed found on the car's bus");
    // The monitor stopped during the check: that, not a check that can't go on.
    expect(speedFromText({ ...base, canShadow: { state: "failed", frames: 0 } as never, canProbation: { state: "checking", profile } }, t)).toBe(
      "OBD · reading the wheels stopped",
    );
    // Passed: the wheels as soon as their speed comes.
    expect(speedFromText({ ...base, speed: sample(true), canProbation: { state: "passed", profile } }, t)).toBe("The wheels");
  });
});
