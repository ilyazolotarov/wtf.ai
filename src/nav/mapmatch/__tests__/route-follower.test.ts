import { RouteFollower } from "@/nav/mapmatch/route-follower";

// A planned route: 1 km east, left, 400 m north. The car drives it; the phone reads its speed 25 % low.
const ROUTE: [number, number][] = [
  [0, 0],
  [1000, 0],
  [1000, 400],
];

function drive(follower: RouteFollower, phoneScale: number) {
  let tUs = 0;
  const step = (dtS: number, speedMps: number, yawRate: number) => {
    tUs += dtS * 1e6;
    follower.step({ tUs, dtS, speedMps: speedMps * phoneScale, yawRate, valid: true, stopped: speedMps === 0 });
  };
  for (let i = 0; i < 50; i++) step(0.1, 0, 0);
  // 960 m east at 12 m/s, a 90° left turn over 4.5 s at 5 m/s (≈ 14 m), then 300 m north.
  for (let i = 0; i < 800; i++) step(0.1, 12, 0);
  for (let i = 0; i < 45; i++) step(0.1, 5, Math.PI / 2 / 4.5);
  for (let i = 0; i < 300; i++) step(0.1, 10, 0);
}

describe("RouteFollower", () => {
  test("the route's turn pins the car whatever the phone's speed did before it", () => {
    const follower = new RouteFollower(ROUTE);
    drive(follower, 0.75);
    const end = follower.estimate();
    // Truth: ~960 + 14 + 300 m along it, on the northbound leg. 0.75× alone would put it ~950 m along, before the turn.
    expect(end.e).toBeCloseTo(1000, -1);
    expect(Math.abs(end.alongM - 1290)).toBeLessThan(60);
  });

  test("a dot lagging kilometres behind is on the route's turn once the car has turned", () => {
    // 10 km straight on (a highway), then right. The phone reads 40 % of the speed: kilometres behind at the turn.
    const follower = new RouteFollower([
      [0, 0],
      [0, 10_000],
      [1000, 10_000],
    ]);
    let tUs = 0;
    const step = (dtS: number, speedMps: number, yawRate: number) => {
      tUs += dtS * 1e6;
      follower.step({ tUs, dtS, speedMps: speedMps * 0.4, yawRate, valid: true, stopped: false });
    };
    for (let i = 0; i < 3334; i++) step(0.1, 30, 0); // 10 km
    expect(follower.estimate().alongM).toBeLessThan(7000);
    for (let i = 0; i < 45; i++) step(0.1, 5, -Math.PI / 2 / 4.5); // a right turn (clockwise: negative yaw rate)
    for (let i = 0; i < 300; i++) step(0.1, 10, 0); // 300 m east
    expect(Math.abs(follower.estimate().alongM - 10_300)).toBeLessThan(100);
  });

  test("on a straight road it keeps the phone's distance (times the expected scale)", () => {
    const follower = new RouteFollower([
      [0, 0],
      [0, 3000],
    ]);
    let tUs = 0;
    for (let i = 0; i < 1000; i++) {
      tUs += 1e5;
      follower.step({ tUs, dtS: 0.1, speedMps: 10, yawRate: 0, valid: true, stopped: false });
    }
    // 1000 m by the phone; nothing on the route says otherwise, so near the prior's scale.
    expect(follower.estimate().alongM).toBeGreaterThan(900);
    expect(follower.estimate().alongM).toBeLessThan(1400);
  });
});
