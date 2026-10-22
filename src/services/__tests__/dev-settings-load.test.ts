import { loadDevSettings } from "../dev-settings-load";
import type { DevSettings } from "../runtime";

const defaults: DevSettings = {
  showEmulators: false,
  showParticles: false,
  outageButton: false,
  phoneOnly: false,
  wheelSpeed: true,
  wheelYaw: true,
  rpmPeriodS: 5,
  positionShare: false,
};

describe("loadDevSettings", () => {
  it("nothing stored: the defaults", () => {
    expect(loadDevSettings(null, defaults)).toEqual(defaults);
  });

  it("stored settings over the defaults", () => {
    expect(loadDevSettings({ version: 2, wheelSpeed: false, wheelYaw: false }, defaults)).toEqual({ ...defaults, wheelSpeed: false, wheelYaw: false });
  });

  it("a setting whose default changed since it was stored: the new default", () => {
    // Saved before turns from the wheels were on for everyone: off then only because it was the default.
    expect(loadDevSettings({ wheelSpeed: false, wheelYaw: false }, defaults)).toEqual({ ...defaults, wheelSpeed: false });
  });

  it("removed settings are dropped: an old CAN mode leaves the wheels' speed on", () => {
    const loaded = loadDevSettings({ can: "off", canShadowIds: "215", mapMatchLoop: "open", routeHint: true, showParticles: true }, defaults);
    expect(loaded).toEqual({ ...defaults, showParticles: true });
  });
});
