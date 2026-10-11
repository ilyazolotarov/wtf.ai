import { CarStateDecoder, type CarStateSample } from "../car-state";
import { readSignal, signal, writeSignal } from "../dbc";
import { MAKES } from "../mappings";
import { allProfiles, makeForVin, matchProfiles, profileByKey, type Profile } from "../profile";
import signalsJson from "../signals.json";

const SIGNALS = signalsJson as unknown as { dbcs: Record<string, { msgs: Record<string, { id: number; size: number; sigs: Record<string, never> }> }> };

/** A frame of `msg` in `dbc` with these signal values (others zero). */
function frame(dbc: string, msg: string, values: Record<string, number>): { id: number; data: number[] } {
  const m = SIGNALS.dbcs[dbc].msgs[msg];
  const data = new Array<number>(m.size).fill(0);
  for (const [sig, v] of Object.entries(values)) writeSignal(signal(m.sigs[sig]), data, v);
  return { id: m.id, data };
}

function decode(p: Profile, frames: { tUs: number; id: number; data: number[] }[]): CarStateSample[] {
  const d = new CarStateDecoder(p);
  return frames.flatMap((f) => d.push(f.tUs, f.id, f.data));
}

const of = <Q extends CarStateSample["q"]>(xs: CarStateSample[], q: Q) =>
  xs.filter((s): s is Extract<CarStateSample, { q: Q }> => s.q === q);

describe("DBC signals", () => {
  test("big endian, as opendbc reads it", () => {
    // A wheel speed 7|16@0+ (0.01,-100) km/h; raw 0x3A98 = 15000 → 50 km/h.
    const fl = signal([7, 16, 0, 0, 0.01, -100]);
    expect(readSignal(fl, [0x3a, 0x98, 0, 0, 0, 0, 0, 0])).toBeCloseTo(50, 6);
    // GEAR 2|3@0+: the low 3 bits of byte 0.
    expect(readSignal(signal([2, 3, 0, 0, 1, 0]), [0xfc])).toBe(4);
    // Spanning three bytes: 12 bits from bit 3 of byte 0.
    const s = signal([3, 12, 0, 0, 1, 0]);
    expect(readSignal(s, [0x0a, 0xbc, 0xff])).toBe(0xabc);
  });

  test("little endian and signed", () => {
    const s = signal([4, 10, 1, 1, 0.5, 0]);
    const data: number[] = [0, 0];
    writeSignal(s, data, -100);
    expect(readSignal(s, data)).toBe(-100);
    expect(data).toEqual([(0x338 & 0xf) << 4, 0x338 >> 4]);
  });

  test("a frame too short for the signal reads NaN", () => {
    expect(readSignal(signal([55, 16, 0, 0, 1, 0]), [1, 2, 3])).toBeNaN();
  });

  test("write → read round trip on every mapped signal", () => {
    for (const [name, dbc] of Object.entries(SIGNALS.dbcs)) {
      for (const m of Object.values(dbc.msgs)) {
        for (const def of Object.values(m.sigs) as unknown as Parameters<typeof signal>[0][]) {
          const s = signal(def);
          const data = new Array<number>(m.size).fill(0);
          const raw = s.size === 1 ? 1 : Math.min(2 ** (s.size - 1) - 1, 1234);
          const v = raw * s.factor + s.offset;
          writeSignal(s, data, v);
          expect([name, readSignal(s, data)]).toEqual([name, expect.closeTo(v, 6)]);
        }
      }
    }
  });
});

describe("profiles", () => {
  test("every mapping resolves against every one of its DBCs with a speed source", () => {
    const profiles = allProfiles();
    expect(profiles.length).toBe(MAKES.flatMap((m) => m.mappings.flatMap((x) => x.dbcs)).length);
    for (const p of profiles) {
      expect([p.key, p.speedIds.length > 0]).toEqual([p.key, true]);
      expect([p.key, p.gear.length > 0]).toEqual([p.key, true]);
      expect([p.key, p.steer.length > 0]).toEqual([p.key, true]);
    }
  });

  test("the VIN's WMI gives the make, longest prefix first", () => {
    expect(makeForVin("JM3KFBDM1J0123456")).toBe("mazda");
    expect(makeForVin("JTDKN3DU0A0123456")).toBe("toyota");
    expect(makeForVin("WVWZZZ1KZ6W123456")).toBe("volkswagen");
    expect(makeForVin("1G1ZD5ST0JF123456")).toBe("gm");
    expect(makeForVin("XTA210930Y0123456")).toBeNull();
    expect(makeForVin(null)).toBeNull();
  });

  test("the profile is picked from the ids heard, within the VIN's make", () => {
    const p = profileByKey("mazda/mazda/mazda_2017")!;
    const seen = new Map([...p.ids].map(([id, d]) => [id, { frames: 100, len: d.size }]));
    expect(matchProfiles(seen, "JM3KFBDM1J0123456")[0].profile.key).toBe(p.key);
    // Only the ids the shadow listened for count.
    const listened = new Set([0x215, 0x228]);
    const heard = new Map([...seen].filter(([id]) => listened.has(id)));
    const m = matchProfiles(heard, "JM3KFBDM1J0123456", listened)[0];
    expect(m).toMatchObject({ seen: 2, heard: 2, score: 1, speed: true });
    // A wrong length doesn't count as seen.
    const wrong = new Map([[0x215, { frames: 100, len: 5 }]]);
    expect(matchProfiles(wrong, "JM3KFBDM1J0123456")).toEqual([]);
  });
});

describe("car state", () => {
  test("wheels in m/s, speed, gear from the value table, steering, brake", () => {
    const p = profileByKey("mazda/mazda/mazda_2017")!;
    const dbc = "mazda_2017";
    const out = decode(p, [
      { tUs: 0, ...frame(dbc, "WHEEL_SPEEDS", { FL: 36, FR: 36, RL: 35.64, RR: 36.36 }) },
      { tUs: 10, ...frame(dbc, "ENGINE_DATA", { SPEED: 36 }) },
      { tUs: 20, ...frame(dbc, "GEAR", { GEAR: 2 }) },
      { tUs: 30, ...frame(dbc, "STEER", { STEER_ANGLE: -90.5 }) },
      { tUs: 40, ...frame(dbc, "PEDALS", { BRAKE_ON: 1 }) },
    ]);
    expect(of(out, "wheels")[0].v.map((v) => v * 3.6)).toEqual([36, 36, 35.64, 36.36].map((v) => expect.closeTo(v, 6)));
    expect(of(out, "speed")[0].v).toBeCloseTo(10, 6);
    expect(of(out, "gear")[0]).toMatchObject({ gear: "R", raw: 2 });
    expect(of(out, "steer")[0].deg).toBeCloseTo(-90.5, 6);
    expect(of(out, "brake")[0].on).toBe(true);
  });

  test("alternatives: the first one heard wins, a later one only while the earlier is silent", () => {
    const p = profileByKey("hyundai/can/hyundai_can_generated")!;
    const dbc = "hyundai_can_generated";
    const lever = (tUs: number) => ({ tUs, ...frame(dbc, "LVR12", { CF_Lvr_Gear: 7 }) }); // R
    const gearbox = (tUs: number) => ({ tUs, ...frame(dbc, "TCU12", { CUR_GR: 1 }) }); // D
    const gears = of(decode(p, [lever(0), gearbox(10_000), lever(20_000), gearbox(5_000_000)]), "gear");
    expect(gears.map((g) => [g.tUs, g.gear])).toEqual([
      [0, "R"],
      [20_000, "R"],
      [5_000_000, "D"],
    ]);
  });

  test("wheel direction signals (GM) and sign signals (VW)", () => {
    const gm = profileByKey("gm/global-a/gm_global_a_powertrain_generated")!;
    const g = "gm_global_a_powertrain_generated";
    const wheels = of(
      decode(gm, [
        { tUs: 0, ...frame(g, "EBCMWheelSpdRear", { RLWheelSpd: 5, RRWheelSpd: 5, RLWheelDir: 2, RRWheelDir: 2 }) },
        { tUs: 10_000, ...frame(g, "EBCMWheelSpdFront", { FLWheelSpd: 5, FRWheelSpd: 5 }) },
      ]),
      "wheels",
    );
    expect(wheels).toHaveLength(1);
    expect(wheels[0].v.every((v) => v < 0)).toBe(true);

    const vw = profileByKey("volkswagen/mqb/vw_mqb")!;
    const steer = of(decode(vw, [{ tUs: 0, ...frame("vw_mqb", "LWI_01", { LWI_Lenkradwinkel: 45, LWI_VZ_Lenkradwinkel: 1 }) }]), "steer");
    expect(steer[0].deg).toBeCloseTo(-45, 1);
  });

  test("a sum of two signals (Toyota), explicit gear values, units", () => {
    const toyota = profileByKey("toyota/toyota/toyota_nodsu_pt_generated")!;
    const t = "toyota_nodsu_pt_generated";
    const steer = of(decode(toyota, [{ tUs: 0, ...frame(t, "STEER_ANGLE_SENSOR", { STEER_ANGLE: 30, STEER_FRACTION: 0.5 }) }]), "steer");
    expect(steer[0].deg).toBeCloseTo(30.5, 6);

    const byd = profileByKey("byd/atto3/byd_atto3")!;
    const out = decode(byd, [
      { tUs: 0, ...frame("byd_atto3", "DRIVE_STATE", { GEAR: 4 }) },
      { tUs: 0, ...frame("byd_atto3", "WHEELSPEED_CLEAN", { WHEELSPEED_CLEAN: 72 }) },
    ]);
    expect(of(out, "gear")[0].gear).toBe("D");
    expect(of(out, "speed")[0].v).toBeCloseTo(20, 1);

    const cusw = profileByKey("chrysler/cusw/chrysler_cusw")!;
    const mps = of(decode(cusw, [{ tUs: 0, ...frame("chrysler_cusw", "BRAKE_1", { VEHICLE_SPEED: 12.5 }) }]), "speed");
    expect(mps[0].v).toBeCloseTo(12.5, 1);
  });
});
