import { TripDetector, type RecorderState, type StartReason } from "@/triplog/trip-detector";
import type { EndReason } from "@/triplog/schema";

const s = (sec: number) => sec * 1_000_000;

function setup() {
  const events: string[] = [];
  const d = new TripDetector({
    onStart: (r: StartReason) => events.push(`start:${r}`),
    onEnd: (r: EndReason) => events.push(`end:${r}`),
    onState: (st: RecorderState) => events.push(st),
  });
  return { d, events };
}

describe("TripDetector", () => {
  test("engine start → recording; ignition off → end → linger → armed", () => {
    const { d, events } = setup();
    d.onLink(true, s(0));
    d.onEngine("engine-off", s(1));
    expect(d.wantsPreroll).toBe(true);
    d.onEngine("engine-running", s(3));
    d.onSpeed(30, s(10));
    d.onEngine("ignition-off", s(600));
    d.tick(s(600 + 15 * 60));
    expect(events).toEqual(["armed", "recording", "start:engine", "end:ignition-off", "lingering", "armed"]);
  });

  test("stop-start at a light doesn't end the trip; long parked stop does", () => {
    const { d, events } = setup();
    d.onLink(true, s(0));
    d.onEngine("engine-running", s(1));
    d.onSpeed(0, s(100));
    d.onEngine("engine-off", s(101)); // i-stop
    d.tick(s(160));
    d.onEngine("engine-running", s(161));
    d.onSpeed(20, s(162));
    expect(d.state).toBe("recording");
    d.onSpeed(0, s(200));
    d.onEngine("engine-off", s(201));
    d.tick(s(200 + 299));
    expect(d.state).toBe("recording");
    d.tick(s(200 + 301));
    expect(events).toContain("end:parked-timeout");
  });

  test("hybrid pulls away in EV mode → speed start", () => {
    const { d, events } = setup();
    d.onLink(true, s(0));
    d.onEngine("engine-off", s(1));
    d.onSpeed(3, s(2));
    expect(d.state).toBe("armed");
    d.onSpeed(5, s(2.1));
    expect(events).toContain("start:speed");
  });

  test("link lost for 2 min ends the trip; shorter gap doesn't", () => {
    const { d, events } = setup();
    d.onLink(true, s(0));
    d.onEngine("engine-running", s(1));
    d.onLink(false, s(10));
    d.tick(s(100));
    d.onLink(true, s(110));
    d.tick(s(200));
    expect(d.state).toBe("recording");
    d.onLink(false, s(300));
    d.tick(s(421));
    expect(events).toContain("end:link-timeout");
  });

  test("manual trip ignores auto end and starts without an adapter", () => {
    const { d, events } = setup();
    d.manualStart(s(0));
    d.onEngine("ignition-off", s(5));
    d.tick(s(1000));
    expect(d.state).toBe("recording");
    d.manualStop(s(1001));
    expect(events).toEqual(["recording", "start:manual", "end:manual", "lingering"]);
  });

  test("restart while lingering starts a new trip", () => {
    const { d, events } = setup();
    d.onLink(true, s(0));
    d.onEngine("engine-running", s(1));
    d.onEngine("ignition-off", s(100));
    d.onEngine("engine-running", s(400));
    expect(events.filter((e) => e.startsWith("start"))).toHaveLength(2);
  });
});
