// A vehicle profile: a per-make mapping (mappings.ts) resolved against one of its DBCs (signals.json), so every source
// is a CAN id and a bit layout. Also picks the profile for a car from its VIN and the ids seen on its OBD port.
import { readSignal as readValue, signal, type DbcSignals, type Signal, type SignalsFile } from "./dbc";
import {
  MAKES,
  type FlagSource,
  type Gear,
  type GearSource,
  type MakeMappings,
  type Mapping,
  type SignalRef,
  type SpeedUnit,
  type ValueSource,
} from "./mappings";
import signalsJson from "./signals.json";

const SIGNALS = signalsJson as unknown as SignalsFile;

export const OPENDBC_COMMIT = SIGNALS.opendbc;

/** A signal of a frame with this id. */
export interface Field {
  id: number;
  signal: Signal;
}

export interface ValueField {
  id: number;
  read: (data: ArrayLike<number>, len: number) => number;
}

export interface WheelField extends ValueField {
  /** Speed sign of this wheel (−1 reversing), from a direction signal; absent when the car doesn't send one. */
  dir?: ValueField;
}

export interface GearField {
  id: number;
  read: (data: ArrayLike<number>, len: number) => { raw: number; gear: Gear | null };
}

export interface FlagField {
  id: number;
  read: (data: ArrayLike<number>, len: number) => boolean | null;
}

export interface Profile {
  /** "make/mapping/dbc" */
  key: string;
  make: string;
  mapping: string;
  dbc: string;
  /** All wheels in m/s, as [fl, fr, rl, rr]. */
  wheels?: [WheelField, WheelField, WheelField, WheelField];
  /** Alternatives in order of preference; values in m/s, degrees, rad/s. */
  speed: ValueField[];
  gear: GearField[];
  steer: ValueField[];
  brake: FlagField[];
  yaw: ValueField[];
  /** Every id the profile reads, with the DBC's length. */
  ids: Map<number, { msg: string; size: number }>;
  /** Ids that tell the profile is on this bus: wheel speed and speed messages. */
  speedIds: number[];
}

const TO_MPS: Record<SpeedUnit, number> = { kph: 1 / 3.6, mph: 0.44704, mps: 1 };

// openpilot's GEAR_SHIFTER_MAP (opendbc/car/interfaces.py), applied to the value table label upper-cased.
const GEAR_LABELS: Record<string, Gear> = {
  P: "P", PARK: "P", R: "R", REVERSE: "R", N: "N", NEUTRAL: "N", E: "E", ECO: "E", T: "T", MANUAL: "T",
  D: "D", DRIVE: "D", S: "S", SPORT: "S", L: "L", LOW: "L", B: "B", BRAKE: "B",
};

class Resolver {
  readonly ids = new Map<number, { msg: string; size: number }>();
  constructor(
    private readonly dbcName: string,
    private readonly dbc: DbcSignals,
  ) {}

  has(ref: SignalRef, ...extra: (string | undefined)[]): boolean {
    const msg = this.dbc.msgs[ref.msg];
    return !!msg && [ref.sig, ...extra].every((s) => s === undefined || s in msg.sigs);
  }

  field(ref: SignalRef): Field {
    const msg = this.dbc.msgs[ref.msg];
    const def = msg?.sigs[ref.sig];
    if (!def) throw new Error(`${this.dbcName}: no ${ref.msg}.${ref.sig} in signals.json (npm run can:profiles)`);
    this.ids.set(msg.id, { msg: ref.msg, size: msg.size });
    return { id: msg.id, signal: signal(def) };
  }

  value(src: ValueSource, factor = 1): ValueField {
    const main = this.field(src);
    const plus = src.plus ? this.field({ msg: src.msg, sig: src.plus }).signal : null;
    const sign = src.signSig ? this.field({ msg: src.msg, sig: src.signSig }).signal : null;
    const k = (src.scale ?? 1) * factor;
    return {
      id: main.id,
      read: (data, len) => {
        let v = readValue(main.signal, data, len);
        if (plus) v += readValue(plus, data, len);
        if (sign && readValue(sign, data, len) === 1) v = -v;
        return v * k;
      },
    };
  }

  gear(src: GearSource): GearField {
    const f = this.field(src);
    if (src.kind === "reverseLight") {
      return {
        id: f.id,
        read: (data, len) => {
          const raw = readValue(f.signal, data, len);
          return { raw, gear: Number.isNaN(raw) ? null : raw !== 0 ? "R" : "D" };
        },
      };
    }
    const table = src.values ?? labelsToGears(this.dbc.values?.[`${src.msg}.${src.sig}`] ?? {});
    return {
      id: f.id,
      read: (data, len) => {
        const raw = readValue(f.signal, data, len);
        return { raw, gear: table[raw] ?? null };
      },
    };
  }

  flag(src: FlagSource): FlagField {
    const f = this.field(src);
    const on = src.on;
    return {
      id: f.id,
      read: (data, len) => {
        const v = readValue(f.signal, data, len);
        if (Number.isNaN(v)) return null;
        if (on === "nonzero") return v !== 0;
        if ("eq" in on) return on.eq.includes(v);
        return v >= on.ge;
      },
    };
  }
}

function labelsToGears(table: Record<string, string>): Record<number, Gear> {
  const out: Record<number, Gear> = {};
  for (const [value, label] of Object.entries(table)) {
    const gear = GEAR_LABELS[label.toUpperCase().replace(/ /g, "_")];
    if (gear) out[Number(value)] = gear;
  }
  return out;
}

export function resolveProfile(make: MakeMappings, mapping: Mapping, dbcName: string): Profile {
  const dbc = SIGNALS.dbcs[dbcName];
  if (!dbc) throw new Error(`no DBC ${dbcName} in signals.json (npm run can:profiles)`);
  const r = new Resolver(dbcName, dbc);
  let wheels: Profile["wheels"];
  if (mapping.wheels && (["fl", "fr", "rl", "rr"] as const).every((w) => r.has(mapping.wheels![w]))) {
    const k = TO_MPS[mapping.wheels.unit];
    wheels = (["fl", "fr", "rl", "rr"] as const).map((w): WheelField => {
      const src = mapping.wheels![w];
      const field = r.value(src, k);
      if (!src.dir) return field;
      const dir = r.field(src.dir);
      const reverse = src.dir.reverse;
      return { ...field, dir: { id: dir.id, read: (data, len) => (readValue(dir.signal, data, len) === reverse ? -1 : 1) } };
    }) as Profile["wheels"];
  }
  const speed = (mapping.speed ?? []).filter((s) => r.has(s, s.plus, s.signSig)).map((s) => r.value(s, TO_MPS[s.unit]));
  const speedIds = [...new Set([...(wheels ?? []).map((w) => w.id), ...speed.map((s) => s.id)])];
  return {
    key: `${make.make}/${mapping.name}/${dbcName}`,
    make: make.make,
    mapping: mapping.name,
    dbc: dbcName,
    wheels,
    speed,
    gear: (mapping.gear ?? []).filter((g) => r.has(g)).map((g) => r.gear(g)),
    steer: (mapping.steer ?? []).filter((s) => r.has(s, s.plus, s.signSig)).map((s) => r.value(s)),
    brake: (mapping.brake ?? []).filter((b) => r.has(b)).map((b) => r.flag(b)),
    yaw: (mapping.yaw ?? [])
      .filter((s) => r.has(s, s.plus, s.signSig))
      .map((s) => r.value(s, s.unit === "deg/s" ? Math.PI / 180 : 1)),
    ids: r.ids,
    speedIds,
  };
}

let all: Profile[] | null = null;

export function allProfiles(): Profile[] {
  all ??= MAKES.flatMap((make) => make.mappings.flatMap((m) => m.dbcs.map((dbc) => resolveProfile(make, m, dbc))));
  return all;
}

export function profileByKey(key: string): Profile | null {
  return allProfiles().find((p) => p.key === key) ?? null;
}

/** The make whose WMI prefix matches the VIN (longest prefix wins), or null. */
export function makeForVin(vin: string | null | undefined): string | null {
  if (!vin) return null;
  const v = vin.toUpperCase();
  let best: { make: string; len: number } | null = null;
  for (const make of MAKES) {
    for (const wmi of make.wmi) {
      if (v.startsWith(wmi) && (!best || wmi.length > best.len)) best = { make: make.make, len: wmi.length };
    }
  }
  return best?.make ?? null;
}

export interface SeenId {
  frames: number;
  /** Data length of the frames seen with this id (the most common one). */
  len: number;
}

export interface ProfileMatch {
  profile: Profile;
  /** Share of the profile's ids seen with the DBC's length, among the ids that were listened for. */
  score: number;
  seen: number;
  /** The profile's ids that were listened for (all of them when nothing says otherwise). */
  heard: number;
  /** Whether a wheel speed or speed message is among those seen. */
  speed: boolean;
}

/**
 * Profiles that fit the ids seen on the OBD port, best first. `listened` limits the comparison to the ids the monitor
 * passed (the CAN shadow's filters); without it every id counts. With a VIN, only its make's profiles.
 */
export function matchProfiles(seen: Map<number, SeenId>, vin?: string | null, listened?: Set<number>): ProfileMatch[] {
  const make = makeForVin(vin);
  const out: ProfileMatch[] = [];
  for (const profile of allProfiles()) {
    if (make && profile.make !== make) continue;
    const ids = [...profile.ids.entries()].filter(([id]) => !listened || listened.has(id));
    if (!ids.length) continue;
    const hits = ids.filter(([id, { size }]) => seen.get(id)?.len === size).length;
    const speed = profile.speedIds.some((id) => seen.get(id)?.len === profile.ids.get(id)?.size);
    out.push({ profile, score: hits / ids.length, seen: hits, heard: ids.length, speed });
  }
  return out
    .filter((m) => m.seen > 0)
    .sort((a, b) => Number(b.speed) - Number(a.speed) || b.score - a.score || b.seen - a.seen);
}
