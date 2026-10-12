// Decodes a car's CAN frames into car-state samples through its profile: wheel speeds, speed, gear, steering angle,
// brake, yaw rate. A quantity with alternatives takes the first one whose message was heard within ALT_FRESH_US
// (carstate picks by platform flags; the bus tells the same thing).
import type { Gear } from "./mappings";
import type { FlagField, GearField, Profile, ValueField } from "./profile";

export type CarStateSample =
  | { q: "wheels"; tUs: number; /** m/s [fl, fr, rl, rr], negative only where the car sends a direction */ v: [number, number, number, number] }
  | { q: "speed"; tUs: number; /** m/s */ v: number }
  | { q: "gear"; tUs: number; gear: Gear | null; raw: number }
  | { q: "steer"; tUs: number; /** degrees, positive left */ deg: number }
  | { q: "brake"; tUs: number; on: boolean }
  | { q: "yaw"; tUs: number; /** rad/s, positive left */ radps: number };

export type CarQuantity = CarStateSample["q"];

/** How long a message counts as present when choosing between alternatives. */
const ALT_FRESH_US = 1_000_000;
/** Wheels split across messages are combined only from frames this close in time. */
const WHEEL_FRESH_US = 200_000;

interface Alt<F> {
  field: F;
  lastUs: number;
}

export class CarStateDecoder {
  private readonly byId = new Map<number, ((tUs: number, data: ArrayLike<number>, len: number) => CarStateSample | null)[]>();
  private readonly wheel: { v: number; dir: number; tUs: number; dirUs: number }[] = [0, 1, 2, 3].map(() => ({
    v: NaN,
    dir: 1,
    tUs: -Infinity,
    dirUs: -Infinity,
  }));
  private readonly brakeOn = new Map<number, { on: boolean; tUs: number }>();
  /** Ids that carry a wheel speed: one wheel sample per frame, once all its wheels are read. */
  private readonly wheelIds = new Set<number>();

  constructor(readonly profile: Profile) {
    const { wheels } = profile;
    if (wheels) {
      wheels.forEach((w, i) => {
        this.wheelIds.add(w.id);
        this.on(w.id, (tUs, data, len) => {
          const v = w.read(data, len);
          if (!Number.isNaN(v)) Object.assign(this.wheel[i], { v, tUs });
          return null;
        });
        const dir = w.dir;
        if (dir) {
          this.on(dir.id, (tUs, data, len) => {
            const d = dir.read(data, len);
            if (!Number.isNaN(d)) Object.assign(this.wheel[i], { dir: d, dirUs: tUs });
            return null;
          });
        }
      });
    }
    this.values(profile.speed, (tUs, v) => ({ q: "speed", tUs, v }));
    this.values(profile.steer, (tUs, deg) => ({ q: "steer", tUs, deg }));
    this.values(profile.yaw, (tUs, radps) => ({ q: "yaw", tUs, radps }));
    this.alternatives(profile.gear, (f: GearField, tUs, data, len) => {
      const { raw, gear } = f.read(data, len);
      return Number.isNaN(raw) ? null : { q: "gear", tUs, gear, raw };
    });
    profile.brake.forEach((f: FlagField, i) => {
      this.on(f.id, (tUs, data, len) => {
        const on = f.read(data, len);
        if (on === null) return null;
        this.brakeOn.set(i, { on, tUs });
        let any = false;
        for (const b of this.brakeOn.values()) if (b.on && tUs - b.tUs <= ALT_FRESH_US) any = true;
        return { q: "brake", tUs, on: any };
      });
    });
  }

  /** The ids this decoder reads. */
  get ids(): number[] {
    return [...this.byId.keys()];
  }

  /** Samples decoded from one frame (none when the frame isn't one the profile reads). */
  push(tUs: number, id: number, data: ArrayLike<number>, len = data.length): CarStateSample[] {
    const handlers = this.byId.get(id);
    if (!handlers) return [];
    const out: CarStateSample[] = [];
    for (const h of handlers) {
      const s = h(tUs, data, len);
      if (s) out.push(s);
    }
    // After every wheel of the frame: a sample per wheel read mixed this frame's wheels with the last one's
    // (2026-10-12: four samples per frame where the car sends all four wheels in one).
    if (this.wheelIds.has(id)) {
      const w = this.wheelSample(tUs);
      if (w) out.push(w);
    }
    return out;
  }

  private on(id: number, h: (tUs: number, data: ArrayLike<number>, len: number) => CarStateSample | null) {
    const list = this.byId.get(id);
    if (list) list.push(h);
    else this.byId.set(id, [h]);
  }

  private wheelSample(tUs: number): CarStateSample | null {
    const v: number[] = [];
    for (const w of this.wheel) {
      if (tUs - w.tUs > WHEEL_FRESH_US) return null;
      v.push(tUs - w.dirUs <= WHEEL_FRESH_US ? w.v * w.dir : w.v);
    }
    return { q: "wheels", tUs, v: v as [number, number, number, number] };
  }

  private values(fields: ValueField[], make: (tUs: number, v: number) => CarStateSample) {
    this.alternatives(fields, (f, tUs, data, len) => {
      const v = f.read(data, len);
      return Number.isNaN(v) ? null : make(tUs, v);
    });
  }

  /** Each alternative's frames yield samples only while no earlier alternative was heard within ALT_FRESH_US. */
  private alternatives<F extends { id: number }>(
    fields: F[],
    decode: (f: F, tUs: number, data: ArrayLike<number>, len: number) => CarStateSample | null,
  ) {
    const alts: Alt<F>[] = fields.map((field) => ({ field, lastUs: -Infinity }));
    alts.forEach((alt, i) => {
      this.on(alt.field.id, (tUs, data, len) => {
        alt.lastUs = tUs;
        for (let j = 0; j < i; j++) if (tUs - alts[j].lastUs <= ALT_FRESH_US) return null;
        return decode(alt.field, tUs, data, len);
      });
    });
  }
}

/** Speed sign from the gear: R reverses, everything else (including unknown) is forward. */
export function gearSign(gear: Gear | null | undefined): 1 | -1 {
  return gear === "R" ? -1 : 1;
}
