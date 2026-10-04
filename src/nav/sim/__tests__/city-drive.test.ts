import { readFileSync } from "node:fs";
import path from "node:path";

import { haversineM } from "@/nav/geo";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { cityDrive } from "@/nav/sim/city-drive";

// The fixture graph (src/nav/mapmatch/__tests__/particle-filter.test.ts): a long road with branches.
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));

describe("cityDrive", () => {
  const frame = new LocalFrame(ORIGIN);
  const g = graph();
  // The fixture's long road (1.7 km, primary) starts at the origin.
  const drive = cityDrive({ graph: g, frame, start: { e: 300, n: 0 }, durationS: 240, seed: 2 });

  test("drives the roads, a lane to the side of their centre lines", () => {
    expect(drive.distanceM).toBeGreaterThan(800);
    let far = 0;
    for (const p of drive.truth.filter((_, i) => i % 10 === 0)) {
      const [e, n] = frame.toEnu(p);
      const near = g.edgesNear(e, n, 30)[0];
      if (!near || near.distanceM > 8) far++;
    }
    // Corner cutting and lane changes, never off into the fields.
    expect(far).toBeLessThan(drive.truth.length / 10 / 50);
  });

  test("logs the sensors a phone would: IMU, OBD speed and GNSS from the truth", () => {
    const { trip } = drive;
    expect(trip.imu.length).toBeGreaterThan(100 * 250);
    expect(trip.obdSpeed.length).toBeGreaterThan(20 * 250);
    // OBD integrated over the drive ≈ the distance (scale 0.981, rounding, zero below 2.5 km/h).
    let obd = 0;
    for (let i = 1; i < trip.obdSpeed.length; i++) obd += trip.obdSpeed[i - 1].speedMps * (trip.obdSpeed[i].tUs - trip.obdSpeed[i - 1].tUs) / 1e6;
    expect(obd / drive.distanceM).toBeGreaterThan(0.96);
    expect(obd / drive.distanceM).toBeLessThan(1.0);
    // GNSS within a few metres of the truth.
    const errors = trip.gnss.map((f) => haversineM(f, drive.truthAt(f.tUs))).sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length / 2)]).toBeLessThan(6);
  });

  test("is repeatable for a seed", () => {
    const again = cityDrive({ graph: graph(), frame, start: { e: 300, n: 0 }, durationS: 240, seed: 2 });
    expect(again.distanceM).toBe(drive.distanceM);
    expect(again.truth.at(-1)).toEqual(drive.truth.at(-1));
  });
});
