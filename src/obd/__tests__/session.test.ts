import { VirtualClock, yieldMacrotask } from "@/obd/clock";
import { initVehicle } from "@/obd/elm327/init";
import { probeAdapter, warmReset } from "@/obd/elm327/probe";
import { Elm327Session, Priority } from "@/obd/elm327/session";
import { CLONE_PROFILE, Elm327Emulator, STN_PROFILE } from "@/obd/emulator";
import { EngineStateMachine } from "@/obd/engine-state";
import { ObdPoller } from "@/obd/poller";
import type { RpmSample, SpeedSample } from "@/obd/types";

jest.setTimeout(60_000);

async function setup(profile = {}) {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator(clock, profile);
  await emu.connect();
  const session = new Elm327Session(emu);
  const send = (c: string, o?: { timeoutMs?: number }) => session.send(c, o);
  return { clock, emu, session, send };
}

async function until(cond: () => boolean, maxTicks = 100_000) {
  for (let i = 0; i < maxTicks && !cond(); i++) await new Promise<void>((r) => yieldMacrotask(r));
  if (!cond()) throw new Error("condition not reached");
}

describe("Elm327Session", () => {
  test("runs one command at a time, control before speed", async () => {
    const { session, emu } = await setup();
    const order: string[] = [];
    const a = session.send("010D", { priority: Priority.Speed }).then(() => order.push("010D"));
    const b = session.send("010D", { priority: Priority.Speed }).then(() => order.push("010D#2"));
    const c = session.send("ATI", { priority: Priority.Control }).then(() => order.push("ATI"));
    await Promise.all([a, b, c]);
    // The first speed poll was already in flight; ATI jumps the queue ahead of the second.
    expect(order).toEqual(["010D", "ATI", "010D#2"]);
    expect(emu.commandCount).toBe(3);
  });

  test("exclusive section blocks other commands", async () => {
    const { session } = await setup();
    const order: string[] = [];
    const ex = session.exclusive(async (send) => {
      await send("ATE0");
      order.push("ex1");
      await send("ATI");
      order.push("ex2");
    });
    const other = session.send("010D", { priority: Priority.Speed }).then(() => order.push("poll"));
    await Promise.all([ex, other]);
    expect(order).toEqual(["ex1", "ex2", "poll"]);
  });
});

describe("probe", () => {
  test("genuine adapter with vehicle present", async () => {
    const { send } = await setup();
    const p = await probeAdapter(send);
    expect(p).toMatchObject({ ok: true, elmVersion: "ELM327 v1.5", suspectedClone: false, vehiclePresent: true });
    expect(p.batteryV).toBeCloseTo(14.2);
  });

  test("clone that drops the first command, ignition off", async () => {
    const { send, emu } = await setup(CLONE_PROFILE);
    emu.setVehicle({ ignition: false, rpm: 0 });
    const p = await probeAdapter(send);
    expect(p).toMatchObject({ ok: true, suspectedClone: true, description: null, chip: null, vehiclePresent: false });
  });

  test("STN chip identified", async () => {
    const { send } = await setup(STN_PROFILE);
    expect((await probeAdapter(send)).chip).toBe("STN2255 v5.10.3");
  });

  test("non-ELM device fails at reset", async () => {
    const { send } = await setup({ isElm: false });
    expect(await probeAdapter(send)).toMatchObject({ ok: false, failedStep: "reset" });
  });
});

describe("init", () => {
  test("genuine: protocol locked, ECU pinned, response count, VIN", async () => {
    const { send, emu } = await setup();
    await probeAdapter(send);
    const r = await initVehicle(send);
    expect(r.ok).toBe(true);
    expect(r.protocolNumber).toBe(6);
    expect(r.vehicle).toMatchObject({ protocol: "A6", vin: "JM3KFBDM1J0123456", speedEcu: "7E8" });
    expect(r.vehicle.supportedPids01).toEqual(expect.arrayContaining(["0C", "0D"]));
    expect(r.capabilities).toEqual({ responseCount: true, adaptiveTiming2: true, physicalAddressing: true });
    expect(r.poll).toEqual({ speedCommand: "010D1", rpmCommand: "010C1" });
    expect(emu.log).toContain("ATSP6");
    expect(emu.log).toContain("ATSH7E0");
  });

  test("reset after a reply arrived one command late still turns echo off", async () => {
    const { send, emu } = await setup(STN_PROFILE);
    await probeAdapter(send);
    emu.desyncOnce();
    expect(await warmReset(send)).toBe(true);
    expect((await initVehicle(send)).ok).toBe(true);
    expect((await send("ATI")).raw).not.toMatch(/^ATI/);
  });

  test("setup command answered by a late banner is sent again", async () => {
    const { send, emu } = await setup(STN_PROFILE);
    await probeAdapter(send);
    emu.desyncOnce();
    await send("ATWS"); // stale "STOPPED"; the banner answers the next command
    expect((await initVehicle(send)).ok).toBe(true);
    expect((await send("ATI")).raw).not.toMatch(/^ATI/);
  });

  test("one stall while timing 010D1 doesn't rule it out", async () => {
    const { send, emu } = await setup(STN_PROFILE);
    await probeAdapter(send);
    let n = 0;
    emu.desyncOnce((c) => c === "010D1" && ++n === 3);
    const r = await initVehicle(send);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(r.capabilities.responseCount).toBe(true);
    expect(r.poll.speedCommand).toBe("010D1");
  });

  test("clone: falls back to plain commands and functional addressing", async () => {
    const { send, emu } = await setup(CLONE_PROFILE);
    await probeAdapter(send);
    const r = await initVehicle(send);
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual({ responseCount: false, adaptiveTiming2: false, physicalAddressing: false });
    expect(r.poll).toEqual({ speedCommand: "010D", rpmCommand: "010C" });
    expect(emu.log).toContain("ATAR");
  });
});

describe("ObdPoller", () => {
  test("speed back-to-back, rpm every 5 s, rate reflects adapter latency", async () => {
    const { session, clock, emu, send } = await setup();
    await probeAdapter(send);
    const init = await initVehicle(send);
    emu.setVehicle({ speedKph: 72, rpm: 2000 });
    const speeds: SpeedSample[] = [];
    const rpms: RpmSample[] = [];
    const engine = new EngineStateMachine(() => undefined);
    const poller = new ObdPoller(session, clock, engine, init.poll, {
      onSpeed: (s) => speeds.push(s),
      onRpm: (s) => rpms.push(s),
      onBattery: () => undefined,
      onNeedsReinit: () => undefined,
    });
    const start = clock.nowUs();
    poller.start();
    await until(() => clock.nowUs() - start >= 20_000_000);
    await poller.stop();

    expect(engine.state).toBe("engine-running");
    expect(speeds[0].speedMps).toBeCloseTo(20);
    // 40 ms per poll → ~25 Hz minus rpm/battery slots.
    const hz = poller.stats.snapshot(clock.nowUs()).speedHz;
    expect(hz).toBeGreaterThan(20);
    expect(hz).toBeLessThan(26);
    expect(rpms.length).toBeGreaterThanOrEqual(4);
    expect(rpms.length).toBeLessThanOrEqual(5);
    expect(speeds[1].tUs).toBe((speeds[1].txUs + speeds[1].rxUs) / 2);
  });

  test("speed cap limits the rate", async () => {
    const { session, clock, send } = await setup();
    await probeAdapter(send);
    const init = await initVehicle(send);
    const engine = new EngineStateMachine(() => undefined);
    const poller = new ObdPoller(session, clock, engine, { ...init.poll, maxSpeedHz: 10 }, {
      onSpeed: () => undefined,
      onRpm: () => undefined,
      onBattery: () => undefined,
      onNeedsReinit: () => undefined,
    });
    const start = clock.nowUs();
    poller.start();
    await until(() => clock.nowUs() - start >= 10_000_000);
    await poller.stop();
    expect(poller.stats.snapshot(clock.nowUs()).speedHz).toBeCloseTo(10, 0);
  });

  test("ignition off: speed polling stops, rpm probe goes on, restart detected", async () => {
    const { session, clock, emu, send } = await setup();
    await probeAdapter(send);
    const init = await initVehicle(send);
    const engine = new EngineStateMachine(() => undefined);
    let speedCount = 0;
    const poller = new ObdPoller(session, clock, engine, init.poll, {
      onSpeed: () => speedCount++,
      onRpm: () => undefined,
      onBattery: () => undefined,
      onNeedsReinit: () => undefined,
    });
    poller.start();
    await until(() => engine.state === "engine-running");
    emu.setVehicle({ ignition: false, rpm: 0 });
    await until(() => engine.state === "ignition-off");
    const frozen = speedCount;
    const commandsBefore = emu.commandCount;
    const t0 = clock.nowUs();
    await until(() => clock.nowUs() - t0 >= 30_000_000);
    expect(speedCount).toBe(frozen);
    expect(emu.commandCount - commandsBefore).toBeLessThanOrEqual(8); // ~6 rpm probes + battery
    emu.setVehicle({ ignition: true, rpm: 850 });
    await until(() => engine.state === "engine-running");
    await poller.stop();
  });

  test("ECU awake with the engine off, answering a latched rpm: engine-off until it really runs", async () => {
    const { session, clock, emu, send } = await setup();
    await probeAdapter(send);
    const init = await initVehicle(send);
    const engine = new EngineStateMachine(() => undefined);
    const poller = new ObdPoller(session, clock, engine, init.poll, {
      onSpeed: () => undefined,
      onRpm: () => undefined,
      onBattery: () => undefined,
      onNeedsReinit: () => undefined,
    });
    emu.setVehicle({ rpm: 0, rpmLatched: 796.5 });
    poller.start();
    const t0 = clock.nowUs();
    await until(() => clock.nowUs() - t0 >= 60_000_000);
    expect(engine.state).toBe("engine-off");
    emu.setVehicle({ rpm: 850, rpmLatched: undefined });
    await until(() => engine.state === "engine-running");
    emu.setVehicle({ rpm: 0, rpmLatched: 724 });
    await until(() => engine.state === "engine-off");
    await poller.stop();
  });
});
