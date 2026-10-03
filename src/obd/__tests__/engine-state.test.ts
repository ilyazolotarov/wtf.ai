import { EngineStateMachine } from "@/obd/engine-state";
import type { EngineState } from "@/obd/types";

function machine() {
  const changes: EngineState[] = [];
  const m = new EngineStateMachine((s) => changes.push(s));
  return { m, changes };
}

const s = (sec: number) => sec * 1_000_000;

describe("EngineStateMachine", () => {
  test("first rpm classifies immediately, then needs confirmation", () => {
    const { m, changes } = machine();
    m.onRpm(800, s(0));
    expect(m.state).toBe("engine-running");
    m.onRpm(0, s(5));
    expect(m.state).toBe("engine-running");
    m.onRpm(0, s(7));
    expect(m.state).toBe("engine-off");
    expect(changes).toEqual(["engine-running", "engine-off"]);
  });

  test("hysteresis band doesn't flip state", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
    m.onRpm(300, s(1));
    m.onRpm(300, s(2));
    expect(m.state).toBe("engine-running");
  });

  test("ECU silence for 10 s → ignition-off; next answer wakes it", () => {
    const { m } = machine();
    m.onRpm(800, s(0));
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
});
