import { loadDevSettings } from "../dev-settings-load";
import type { DevSettings } from "../runtime";

const defaults: DevSettings = {
  showEmulators: false,
  showParticles: false,
  outageButton: false,
  phoneOnly: false,
  wheelSpeed: true,
  wheelYaw: false,
  rpmPeriodS: 5,
};

describe("loadDevSettings", () => {
  it("nothing stored: the defaults", () => {
    expect(loadDevSettings(null, defaults)).toEqual(defaults);
  });

  it("stored settings over the defaults", () => {
    expect(loadDevSettings({ wheelSpeed: false, wheelYaw: true }, defaults)).toEqual({ ...defaults, wheelSpeed: false, wheelYaw: true });
  });

  it("removed settings are dropped: an old CAN mode leaves the wheels' speed on", () => {
    const loaded = loadDevSettings({ can: "off", canShadowIds: "215", mapMatchLoop: "open", routeHint: true, showParticles: true }, defaults);
    expect(loaded).toEqual({ ...defaults, showParticles: true });
  });
});
