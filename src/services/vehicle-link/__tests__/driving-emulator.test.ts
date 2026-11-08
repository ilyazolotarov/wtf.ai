import { allProfiles } from "@/nav/odometry/can/profile";
import { DEFAULT_TRACK_M } from "@/nav/odometry/can/wheel-yaw";
import { VirtualClock } from "@/obd/clock";
import { DrivingEmulator, parseHeadingProfile, parseSpeedProfile, driveProfileNext, profileAt, profileRate, roadCruiseKph, wheelSpeeds } from "../driving-emulator";
import type { EmulatedCar, EmulatedDrive } from "../emulated-drive";

const MAZDA = allProfiles().find((p) => p.key.startsWith("mazda/mazda/"))!;

/** A frame's four wheels as the app's Mazda profile reads them, m/s [fl, fr, rl, rr]. */
function readWheels(data: number[]): number[] {
  return MAZDA.wheels!.map((w) => w.read(data, data.length));
}

describe("speed profile", () => {
  it("reads seconds:km/h points in time order", () => {
    expect(parseSpeedProfile("0:0,10:0,22:50")).toEqual([
      [0, 0],
      [10, 0],
      [22, 50],
    ]);
    expect(parseSpeedProfile("0:0,10:20.5")).toEqual([
      [0, 0],
      [10, 20.5],
    ]);
  });

  it("refuses what isn't one", () => {
    for (const spec of [undefined, "", "0:0", "0:0,10", "0:0,x:5", "0:0,10:-1", "0:0,10:5,10:6", "5:0,2:5"]) {
      expect(parseSpeedProfile(spec)).toBeNull();
    }
  });

  it("goes straight between the points and holds the last", () => {
    const p = parseSpeedProfile("0:0,10:0,20:50,30:20")!;
    expect(profileAt(p, -1)).toBe(0);
    expect(profileAt(p, 5)).toBe(0);
    expect(profileAt(p, 15)).toBe(25);
    expect(profileAt(p, 25)).toBe(35);
    expect(profileAt(p, 99)).toBe(20);
  });
});

describe("heading profile", () => {
  it("takes negative headings (unwrapped degrees) and gives the rate between points", () => {
    const p = parseHeadingProfile("0:-90,10:-90,12:0")!;
    expect(p).toEqual([
      [0, -90],
      [10, -90],
      [12, 0],
    ]);
    expect(profileRate(p, 5)).toBe(0);
    expect(profileRate(p, 11)).toBe(45);
    expect(profileRate(p, 20)).toBe(0);
    expect(parseSpeedProfile("0:-90,10:-90")).toBeNull();
  });
});

describe("the car's wheels (VEHICLE-LINK-SPEC §16.3)", () => {
  it("straight: all four at the speed", () => {
    for (const v of wheelSpeeds(50, 0)) expect(v).toBeCloseTo(50, 9);
  });

  it("turning: the rear wheels' difference over the track is the yaw, the front ones on wider arcs", () => {
    const yaw = 0.3; // left
    const [fl, fr, rl, rr] = wheelSpeeds(36, yaw);
    expect(((rr - rl) / 3.6 / DEFAULT_TRACK_M)).toBeCloseTo(yaw, 9);
    expect((rl + rr) / 2).toBeCloseTo(36, 9);
    expect(fl).toBeGreaterThan(rl);
    expect(fr).toBeGreaterThan(rr);
    expect(rr).toBeGreaterThan(rl);
  });

  it("standing: no turning", () => {
    expect(wheelSpeeds(0, 0.5)).toEqual([0, 0, 0, 0]);
  });

  it("the STN emulator broadcasts them in the Mazda profile's frames, turning with the heading profile", async () => {
    const clock = new VirtualClock();
    let now = 1_000_000;
    const dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
    // 36 km/h from 0 s, turning right 90° over 10 s from 5 s.
    driveProfileNext(parseSpeedProfile("0:36,60:36"), parseHeadingProfile("0:0,5:0,15:90"));
    const emu = new DrivingEmulator("emulator:stn", clock);
    try {
      await emu.connect();
      for (const cmd of ["ATZ", "ATE0", "ATH1", "ATSP6"]) await emu.exchange(cmd, 1000);
      const lines: string[] = [];
      emu.onUnsolicited((text) => lines.push(...text.split(/[\r\n]+/).filter(Boolean)));
      now += 10_000; // 10 s in: in the turn
      await emu.writeRaw("STM");
      for (let i = 0; i < 5; i++) await clock.sleep(20);
      const wheels = lines.filter((l) => l.startsWith("215 ")).map((l) => l.slice(4).split(" ").map((b) => parseInt(b, 16)));
      expect(wheels.length).toBeGreaterThan(0);
      const [, , rl, rr] = readWheels(wheels[0]);
      expect((rl + rr) / 2).toBeCloseTo(10, 1);
      // A right turn: the left wheels faster; 9 °/s.
      expect(((rr - rl) / DEFAULT_TRACK_M) * (180 / Math.PI)).toBeCloseTo(-9, 1);
      expect(lines.some((l) => l.startsWith("228 "))).toBe(true);
    } finally {
      await emu.disconnect();
      driveProfileNext(null);
      dateNow.mockRestore();
    }
  });

  it("counts the profile from the link's start time, not from connecting", async () => {
    const clock = new VirtualClock();
    const now = 1_000_000;
    const dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
    // Standing 10 s, then 36 km/h: started 20 s before connecting, it is already moving.
    driveProfileNext(parseSpeedProfile("0:0,10:0,11:36,60:36"), null, now - 20_000);
    const emu = new DrivingEmulator("emulator:stn", clock);
    try {
      await emu.connect();
      for (const cmd of ["ATZ", "ATE0", "ATH1", "ATSP6"]) await emu.exchange(cmd, 1000);
      const lines: string[] = [];
      emu.onUnsolicited((text) => lines.push(...text.split(/[\r\n]+/).filter(Boolean)));
      await emu.writeRaw("STM");
      for (let i = 0; i < 5; i++) await clock.sleep(20);
      const wheels = lines.filter((l) => l.startsWith("215 ")).map((l) => l.slice(4).split(" ").map((b) => parseInt(b, 16)));
      expect(wheels.length).toBeGreaterThan(0);
      const [, , rl, rr] = readWheels(wheels[0]);
      expect((rl + rr) / 2).toBeCloseTo(10, 1);
    } finally {
      await emu.disconnect();
      driveProfileNext(null);
      dateNow.mockRestore();
    }
  });
});

describe("the emulated car on the map's roads (VEHICLE-LINK-SPEC §13)", () => {
  /** A drive on the roads that begins when asked once `ready`, then is at `car`. */
  function fakeRoad(car: EmulatedCar = { speedKph: 36, yawRad: 0.2 }) {
    const state = { ready: false, begun: false, begin: 0, stop: 0, cruise: [] as number[] };
    const road = {
      get begun() {
        return state.begun;
      },
      begin: () => {
        state.begin++;
        state.begun = state.ready;
        return state.begun;
      },
      at: (_nowMs: number, cruiseKph: number) => (state.cruise.push(cruiseKph), car),
      stop: () => void state.stop++,
    };
    return { road: road as unknown as EmulatedDrive, state };
  }
  const step = (emu: DrivingEmulator) => (emu as unknown as { step(): void }).step();

  it("stands at first and asks for the roads; driving them, its speed and its wheels' turning are the drive's", async () => {
    const clock = new VirtualClock();
    let now = 1_000_000;
    const dateNow = jest.spyOn(Date, "now").mockImplementation(() => now);
    const { road, state } = fakeRoad({ speedKph: 36, yawRad: 0.2 });
    const emu = new DrivingEmulator("emulator:stn", clock, () => road);
    try {
      await emu.connect();
      // No dot or no road yet: standing, idling, asked again every 2 s, past the cycle's own 10 s.
      for (let t = 0; t <= 26_000; t += 200) {
        now = 1_000_000 + t;
        step(emu);
        expect(emu.vehicle).toMatchObject({ ignition: true, speedKph: 0 });
      }
      expect(state.begin).toBe(14);
      // It begins: the car's speed is the drive's.
      state.ready = true;
      now = 1_028_000;
      step(emu);
      step(emu);
      expect(emu.vehicle).toMatchObject({ ignition: true, speedKph: 36 });
      for (const cmd of ["ATZ", "ATE0", "ATH1", "ATSP6"]) await emu.exchange(cmd, 1000);
      const lines: string[] = [];
      emu.onUnsolicited((text) => lines.push(...text.split(/[\r\n]+/).filter(Boolean)));
      await emu.writeRaw("STM");
      for (let i = 0; i < 5; i++) await clock.sleep(20);
      const wheels = lines.filter((l) => l.startsWith("215 ")).map((l) => l.slice(4).split(" ").map((b) => parseInt(b, 16)));
      expect(wheels.length).toBeGreaterThan(0);
      const [, , rl, rr] = readWheels(wheels[0]);
      expect((rl + rr) / 2).toBeCloseTo(10, 1);
      // Turning left at 0.2 rad/s: the right wheels faster.
      expect((rr - rl) / DEFAULT_TRACK_M).toBeCloseTo(0.2, 2);
      // The cycle's cruise on the straight.
      expect(state.cruise.at(-1)).toBe(60);
    } finally {
      await emu.disconnect();
      dateNow.mockRestore();
    }
    expect(state.stop).toBe(1);
  });

  it("cruises at 60, up to 70 every second 2 min, as the cycle did (the speed warning)", () => {
    expect(roadCruiseKph(40)).toBe(60);
    expect(roadCruiseKph(160)).toBe(70);
    expect(roadCruiseKph(200)).toBe(60);
    expect(roadCruiseKph(280)).toBe(60);
  });

  it("a link's profiles drive instead: no roads asked for, so the phone's fixes are kept", async () => {
    const clock = new VirtualClock();
    let asked = 0;
    driveProfileNext(parseSpeedProfile("0:36,60:36"));
    const emu = new DrivingEmulator("emulator:stn", clock, () => (asked++, fakeRoad().road));
    try {
      await emu.connect();
      step(emu);
      expect(asked).toBe(0);
      expect(emu.vehicle.speedKph).toBe(36);
    } finally {
      await emu.disconnect();
      driveProfileNext(null);
    }
  });
});
