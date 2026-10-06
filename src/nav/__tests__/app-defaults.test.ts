import { APP_NAV_DEFAULTS } from "@/nav/app-defaults";
import { DEFAULT_NAV_CONFIG } from "@/nav/navigator";
import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { replayTrip } from "@/nav/replay/replay";

const DRIVE: DriveSegment[] = [
  { durationS: 3, speedMps: 0, yawRateDegS: 0 },
  { durationS: 20, speedMps: 12, yawRateDegS: 0 },
  { durationS: 9, speedMps: 9, yawRateDegS: 10 },
  { durationS: 20, speedMps: 14, yawRateDegS: 0 },
];

// A replay that runs different settings from the app measures a different system. It did once: the app has
// shipped `mapMatchLoop: "closed"` while `DEFAULT_NAV_CONFIG` says `open`, so every replay ran the open loop,
// and the 2026-10-06 off-road excursion looked unreproducible (MAPMATCH-SPEC §15, item 14).
describe("the replay runs what the app runs", () => {
  test("every app default differs from the navigator's own, or it would not need to be listed", () => {
    for (const [key, value] of Object.entries(APP_NAV_DEFAULTS)) {
      expect({ key, value }).not.toEqual({ key, value: DEFAULT_NAV_CONFIG[key as keyof typeof DEFAULT_NAV_CONFIG] });
    }
  });

  test("replayTrip takes them without being asked, and `nav` still overrides one", () => {
    const drive = syntheticDrive({ segments: DRIVE, gnss: "clean", seed: 3 });
    expect(replayTrip(drive.trip).summary.nav.mapMatchLoop).toBe(APP_NAV_DEFAULTS.mapMatchLoop);
    expect(replayTrip(drive.trip, { nav: { mapMatchLoop: "open" } }).summary.nav.mapMatchLoop).toBe("open");
  });
});
