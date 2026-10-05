import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { haversineM } from "@/nav/geo";
import { replayShownTrack, trackAt } from "@/nav/replay/drive-report";
import { replayTrip } from "@/nav/replay/replay";
import { MemoryKeyValueStore, replayTripInApp } from "@/services/navigation/app-replay";
import { CalibrationStore } from "@/services/navigation/calibration-store";

const PHONE = { model: "iPhone14,5", os: "ios 26.0" };
const VIN = "JMZKF0000TEST0001";

const DRIVE: DriveSegment[] = [
  { durationS: 10, speedMps: 0, yawRateDegS: 0 },
  { durationS: 20, speedMps: 12, yawRateDegS: 0 },
  { durationS: 9, speedMps: 8, yawRateDegS: 10 },
  { durationS: 40, speedMps: 12, yawRateDegS: 0 },
  { durationS: 40, speedMps: 0, yawRateDegS: 0 },
];

describe("replayTripInApp", () => {
  test("with nothing stored it shows what replayTrip's dot shows", () => {
    const { trip } = syntheticDrive({ segments: DRIVE, gnss: "clean", seed: 3 });
    const app = replayTripInApp(trip, { calibration: new CalibrationStore(new MemoryKeyValueStore(), PHONE), vin: VIN });
    const direct = replayShownTrack(replayTrip(trip));
    expect(app.published.length).toBeGreaterThan(100);
    expect(app.summary.init?.method).toBe(replayTrip(trip).summary.init?.method);
    const shown = app.published.map((p) => ({ t: (p.timestampUs - trip.startUs) / 1e6, lat: p.latDeg, lon: p.lonDeg, acc: p.accuracyM }));
    const diffs = direct.filter((p) => p.t > 40).map((p) => haversineM(p, trackAt(shown, p.t)!));
    // The app draws its dot up to 1 s ahead of the navigator, which runs 0.3 s behind: a few metres at most.
    expect(Math.max(...diffs)).toBeLessThan(8);
  });

  test("drives replayed in order with one storage: the next starts where the last parked", () => {
    const store = new MemoryKeyValueStore();
    const first = syntheticDrive({ segments: DRIVE, gnss: "clean", seed: 3 });
    const parked = replayTripInApp(first.trip, { calibration: new CalibrationStore(store, PHONE), vin: VIN });
    expect(parked.notes.some((n) => n.text.startsWith("nav parked pose saved"))).toBe(true);
    const end = first.truth.at(-1)!;
    // The next drive leaves from there, jammed: only Wi-Fi-like fixes.
    const next = syntheticDrive({ segments: DRIVE, gnss: "coarse", seed: 4, origin: end, startHeadingRad: end.psi });
    const r = replayTripInApp(next.trip, { calibration: new CalibrationStore(store, PHONE), vin: VIN });
    expect(r.summary.init).toMatchObject({ method: "parked pose", tS: 0 });
    expect(r.notes.some((n) => n.text.startsWith("nav mode dr (parked pose"))).toBe(true);
    // Another car's drive doesn't get it.
    const other = replayTripInApp(next.trip, { calibration: new CalibrationStore(store.copy(), PHONE), vin: "OTHERVIN000000000" });
    expect(other.summary.init?.method).not.toBe("parked pose");
  });
});
