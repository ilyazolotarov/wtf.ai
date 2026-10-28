import { CameraAlert, type CameraInSight } from "@/nav/speed/camera-alert";
import { CameraIndex, parseCameras } from "@/nav/speed/cameras";

const sight = (id: number, distanceM: number, share = 1): CameraInSight => ({
  camera: { id, lat: 50, lon: 30, listed: true },
  distanceM,
  share,
  limitKph: 50,
});

describe("CameraAlert", () => {
  test("a camera shows within 30 s at the speed, once it held a moment", () => {
    const a = new CameraAlert();
    expect(a.update([sight(1, 800)], 25, 0)).toBeNull();
    expect(a.update([sight(1, 740)], 25, 1000)).toBeNull();
    expect(a.update([sight(1, 715)], 25, 2000)).toEqual({ id: 1, lat: 50, lon: 30, distanceM: 715, fromM: 715, limitKph: 50, listed: true });
    expect(a.update([sight(1, 690)], 25, 3000)).toMatchObject({ distanceM: 690, fromM: 715 });
  });

  test("in town at least 250 m ahead", () => {
    const a = new CameraAlert();
    a.update([sight(1, 260)], 5, 0);
    expect(a.update([sight(1, 255)], 5, 1000)).toBeNull();
    a.update([sight(1, 245)], 5, 2000);
    expect(a.update([sight(1, 240)], 5, 3000)?.id).toBe(1);
  });

  test("passed: gone at once out of sight near it, and not shown again soon", () => {
    const a = new CameraAlert();
    a.update([sight(1, 100)], 20, 0);
    a.update([sight(1, 80)], 20, 1000);
    expect(a.update([], 20, 2000)).toBeNull();
    expect(a.ended).toEqual({ id: 1, passed: true, distanceM: 60 });
    a.update([sight(1, 30)], 20, 3000);
    expect(a.update([sight(1, 25)], 20, 4000)).toBeNull();
  });

  test("out of sight farther away: kept 3 s, its distance run down, then gone", () => {
    const a = new CameraAlert();
    a.update([sight(1, 500)], 20, 0);
    a.update([sight(1, 480)], 20, 1000);
    expect(a.update([], 20, 2000)?.distanceM).toBe(460);
    expect(a.update([], 20, 4000)?.distanceM).toBe(420);
    expect(a.update([], 20, 4500)).toBeNull();
    expect(a.ended).toEqual({ id: 1, passed: false, distanceM: 410 });
  });

  test("lost and found within a minute it is the same warning: at once, its bar where it was", () => {
    const a = new CameraAlert();
    a.update([sight(1, 500)], 20, 0);
    a.update([sight(1, 480)], 20, 1000);
    for (const t of [2000, 3000, 4000, 4500]) a.update([], 20, t);
    expect(a.ended).toMatchObject({ id: 1, passed: false });
    expect(a.update([sight(1, 380)], 20, 6000)).toMatchObject({ id: 1, distanceM: 380, fromM: 480 });
  });

  test("the road ahead unseen (no course under 11 km/h on GNSS): held, never passed meanwhile, for up to a minute", () => {
    const a = new CameraAlert();
    a.update([sight(1, 150)], 10, 0);
    a.update([sight(1, 140)], 10, 1000);
    // Creeping at 2 m/s, unseen: the distance runs down, the card stays.
    for (let t = 2000; t <= 50_000; t += 1000) expect(a.update([], 2, t, false)?.id).toBe(1);
    expect(a.update([], 2, 50_500, false)?.distanceM).toBeCloseTo(41, 0);
    // Seen again, it is there.
    expect(a.update([sight(1, 40)], 4, 51_000)?.distanceM).toBe(40);
    // Unseen past a minute it goes, not as passed.
    for (let t = 52_000; t <= 112_000; t += 1000) a.update([], 2, t, false);
    expect(a.update([], 2, 113_000, false)).toBeNull();
    expect(a.ended).toMatchObject({ id: 1, passed: false });
  });

  test("a car standing keeps its camera out of sight, even just before it; moving on, it is passed", () => {
    const a = new CameraAlert();
    a.update([sight(1, 200)], 10, 0);
    a.update([sight(1, 190)], 10, 1000);
    expect(a.update([], 0, 60_000)?.id).toBe(1);
    a.update([sight(1, 30)], 5, 61_000);
    expect(a.update([], 0, 120_000)?.id).toBe(1);
    expect(a.update([], 8, 121_000)).toBeNull();
    expect(a.ended).toMatchObject({ id: 1, passed: true });
  });

  test("not on roads holding less than 0.4 of the belief; a nearer camera takes the card", () => {
    const a = new CameraAlert();
    a.update([sight(1, 300, 0.3)], 15, 0);
    expect(a.update([sight(1, 290, 0.3)], 15, 1000)).toBeNull();
    a.update([sight(2, 400)], 15, 2000);
    expect(a.update([sight(2, 390)], 15, 3000)?.id).toBe(2);
    a.update([sight(3, 200), sight(2, 380)], 15, 4000);
    expect(a.update([sight(3, 190), sight(2, 370)], 15, 5000)?.id).toBe(3);
  });
});

describe("the cameras file", () => {
  test("reads its rows; another format reads as none", () => {
    const cameras = parseCameras(
      JSON.stringify({ format: 1, osm_date: "2026-10-03", cameras: [[50.45, 30.52, 90, 50, 3], [50.46, 30.52, -1, 0, 1]] }),
    );
    expect(cameras).toEqual([
      { id: 0, lat: 50.45, lon: 30.52, bearingRad: Math.PI / 2, limitKph: 50, listed: true },
      { id: 1, lat: 50.46, lon: 30.52, listed: false },
    ]);
    expect(parseCameras(JSON.stringify({ format: 2, cameras: [[50, 30, 0, 50, 1]] }))).toEqual([]);
  });

  test("found by place", () => {
    const index = new CameraIndex(parseCameras(JSON.stringify({ format: 1, cameras: [[50.45, 30.52, 0, 50, 1], [50.46, 30.52, 0, 50, 1], [50.45, 30.6, 0, 50, 1]] })));
    expect(index.near({ lat: 50.4505, lon: 30.52 }, 1500).map((c) => c.id)).toEqual([0, 1]);
    expect(index.near({ lat: 50.45, lon: 30.6 }, 100).map((c) => c.id)).toEqual([2]);
  });
});
