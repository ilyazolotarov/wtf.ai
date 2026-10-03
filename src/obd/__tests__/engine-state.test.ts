import { EngineStateMachine } from "@/obd/engine-state";
import type { EngineState } from "@/obd/types";
import { TripDetector } from "@/triplog/trip-detector";

function machine() {
  const changes: EngineState[] = [];
  const m = new EngineStateMachine((s) => changes.push(s));
  return { m, changes };
}

const s = (sec: number) => sec * 1_000_000;

describe("EngineStateMachine", () => {
  test("first rpm wakes to engine-off; running needs a second, different high reading", () => {
    const { m, changes } = machine();
    m.onRpm(800, s(0));
    expect(m.state).toBe("engine-off");
    m.onRpm(812.5, s(2));
    expect(m.state).toBe("engine-running");
    m.onRpm(0, s(5));
    expect(m.state).toBe("engine-running");
    m.onRpm(0, s(7));
    expect(m.state).toBe("engine-off");
    expect(changes).toEqual(["engine-off", "engine-running", "engine-off"]);
  });

  test("a repeated non-zero rpm is stale: never starts, and stops a running engine", () => {
    const { m, changes } = machine();
    m.onRpm(796.5, s(0));
    for (let i = 1; i <= 50; i++) m.onRpm(796.5, s(5 * i));
    expect(m.state).toBe("engine-off");
    m.onRpm(833.75, s(255));
    m.onRpm(697.75, s(260));
    expect(m.state).toBe("engine-running");
    m.onRpm(724, s(265));
    m.onRpm(724, s(270));
    expect(m.state).toBe("engine-running");
    m.onRpm(724, s(275));
    expect(m.state).toBe("engine-off");
    expect(changes).toEqual(["engine-off", "engine-running", "engine-off"]);
  });

  test("one chance repeat while running doesn't stop the engine", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
    m.onRpm(810, s(2));
    m.onRpm(810, s(7));
    m.onRpm(805.25, s(12));
    m.onRpm(805.25, s(17));
    expect(m.state).toBe("engine-running");
  });

  test("hysteresis band doesn't flip state", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
    m.onRpm(810, s(1));
    m.onRpm(300, s(2));
    m.onRpm(310, s(3));
    expect(m.state).toBe("engine-running");
  });

  test("ECU silence for 10 s → ignition-off; next answer wakes it", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
    m.onRpm(810, s(0.5));
    m.onObdResponse(false, s(1));
    m.onObdResponse(false, s(10));
    expect(m.state).toBe("engine-running");
    m.onObdResponse(false, s(11));
    expect(m.state).toBe("ignition-off");
    m.onRpm(0, s(20));
    expect(m.state).toBe("engine-off");
  });

  test("a valid answer resets the silence timer", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
    m.onRpm(810, s(0.5));
    m.onObdResponse(false, s(1));
    m.onObdResponse(true, s(9));
    m.onObdResponse(false, s(12));
    m.onObdResponse(false, s(20));
    expect(m.state).toBe("engine-running");
  });

  test("speed wakes from ignition-off (hybrid EV mode)", () => {
    const { m } = machine();
    m.onObdResponse(false, s(0));
    m.onObdResponse(false, s(11));
    expect(m.state).toBe("ignition-off");
    m.onSpeed(s(12));
    expect(m.state).toBe("engine-off");
  });

  // Real log 20261003-101005_vwaz7t (Mazda CX-5, OBDLink MX+): parked ~2 min after the
  // previous trip, the ECU woke with the engine off and answered 010C with 796.50 for
  // 280 s; the engine started at ~279 s; after it stopped at ~544 s the ECU kept
  // answering 724.00. RPM was polled every ~5 s.
  test("trip log replay: latched rpm neither starts nor holds a trip", () => {
    const running = [
      833.75, 697.75, 654.75, 652.75, 636.5, 649.5, 645.25, 708.75, 648.75, 646.75, 1686.75, 1177.75, 658.5, 1567.5,
      1503.25, 685.25, 1055.5, 656.25, 1576, 650.25, 649, 1346.5, 1883.25, 1332.25, 951, 661, 2005.25, 2155, 1685.5,
      1374, 1005.25, 1706.5, 2052.75, 1123.5, 1248.75, 1951.5, 1294.25, 1253, 1718, 1358.75, 1256, 1218.25, 1251.5,
      1119, 682.75, 664.5, 743.25, 721, 647.25, 679.75, 680.25, 680, 573,
    ];
    const rpmAt = (sec: number): number => {
      if (sec < 279) return 796.5;
      const i = Math.round((sec - 279) / 5);
      return i < running.length ? running[i] : 724;
    };
    const events: string[] = [];
    const detector = new TripDetector({
      onStart: (r, t) => events.push(`start:${r}@${Math.round(t / 1e6)}`),
      onEnd: (r, t) => events.push(`end:${r}@${Math.round(t / 1e6)}`),
      onState: () => undefined,
    });
    const engine = new EngineStateMachine((st, t) => detector.onEngine(st, t));
    detector.onLink(true, s(0));
    engine.onRpm(803.5, s(-130)); // last reading of the previous trip
    engine.onObdResponse(false, s(-125));
    engine.onObdResponse(false, s(-110)); // ignition off between the trips
    for (let sec = 4; sec <= 1000; sec++) {
      if (sec % 5 === 4) engine.onRpm(rpmAt(sec), s(sec));
      detector.onSpeed(sec > 330 && sec < 500 ? 30 : 0, s(sec));
      detector.tick(s(sec));
    }
    expect(events).toEqual(["start:engine@284", "end:parked-timeout@854"]);
  });
});
