import { discoveredProfile, fieldKey, foundProfile, readField, SpeedFieldFinder, tidy, type FieldLayout } from "../discovery";

/** True speed, km/h: 20 s standing, then 60 s cycles of 0 → 70 → 0 with cruising and a 10 s stop. */
function kphAt(tS: number): number {
  if (tS < 20) return 0;
  const c = (tS - 20) % 60;
  if (c < 10) return 0;
  if (c < 20) return (c - 10) * 4;
  if (c < 30) return 40;
  if (c < 35) return 40 + (c - 30) * 6;
  if (c < 45) return 70;
  if (c < 55) return 70 - (c - 45) * 7;
  return 0;
}

function writeField(f: FieldLayout, data: number[], value: number): void {
  const mask = ((1 << f.bits) - 1) << f.shift;
  const v = (value << f.shift) & mask;
  const word = f.endian === "be" ? (data[f.byte] << 8) | data[f.byte + 1] : data[f.byte] | (data[f.byte + 1] << 8);
  const next = (word & ~mask) | v;
  if (f.endian === "be") {
    data[f.byte] = (next >> 8) & 0xff;
    data[f.byte + 1] = next & 0xff;
  } else {
    data[f.byte] = next & 0xff;
    data[f.byte + 1] = (next >> 8) & 0xff;
  }
}

type Message = {
  id: number;
  len: number | ((n: number) => number);
  fill(data: number[], kph: number, n: number): void;
  /** Sent only this many seconds from the start. */
  untilS?: number;
};

/** Messages at 50 Hz while the monitor listens (0.25 s of each 0.5 s), OBD polls at 2 Hz in whole km/h. */
function run(messages: Message[], seconds = 900): SpeedFieldFinder {
  const finder = new SpeedFieldFinder(messages.map((m) => m.id));
  let n = 0;
  for (let ms = 0; ms <= seconds * 1000; ms += 20) {
    const tUs = ms * 1000;
    const kph = kphAt(ms / 1000);
    if (ms % 500 === 0) finder.addObd(tUs, Math.round(kph));
    if (ms % 500 < 200) continue;
    for (const m of messages) {
      if (m.untilS !== undefined && ms / 1000 >= m.untilS) continue;
      const data = new Array<number>(typeof m.len === "number" ? m.len : m.len(n)).fill(0);
      m.fill(data, kph, n++);
      finder.addFrame(m.id, tUs, data);
    }
    if (finder.judge()) break;
  }
  return finder;
}

const LE14: FieldLayout = { byte: 0, endian: "le", shift: 0, bits: 14 };

describe("SpeedFieldFinder (VEHICLE-LINK-SPEC §16.6)", () => {
  it("finds four little-endian 14-bit wheels at 1/32 km/h among a counter and a checksum", () => {
    const wheels: Message = {
      id: 0x386,
      len: 8,
      fill: (d, kph, n) => {
        for (let w = 0; w < 4; w++) writeField({ ...LE14, byte: 2 * w }, d, Math.round((kph * (1 + w * 0.002)) / 0.03125));
        // A 2-bit alive counter in each word's top bits, as Hyundai sends.
        for (let w = 0; w < 4; w++) d[2 * w + 1] |= (n & 3) << 6;
      },
    };
    const v = run([wheels]).judge();
    expect(v?.found?.id).toBe(0x386);
    const fields = tidy(v!.found!.fields);
    expect(fields.map((f) => [f.byte, f.endian, f.bits, f.shift])).toEqual([0, 2, 4, 6].map((b) => [b, "le", 14, 0]));
    expect(fields.every((f) => f.kphPerCount === 0.03125 && f.offset === 0)).toBe(true);
  });

  it("finds a speed message's one field: big-endian, shifted, with a zero offset of −100 km/h", () => {
    const f: FieldLayout = { byte: 2, endian: "be", shift: 3, bits: 13 };
    const speed: Message = {
      id: 0x1a0,
      len: 8,
      fill: (d, kph, n) => {
        writeField(f, d, Math.round((kph + 100) / 0.05));
        // Flags in the 3 bits below the field.
        d[3] |= (n * 5) & 7;
      },
    };
    const noise: Message = { id: 0x2c0, len: 8, fill: (d, _kph, n) => d.forEach((_, i) => (d[i] = (n * 37 + i * 11) & 0xff)) };
    const v = run([noise, speed]).judge();
    expect(v?.found?.id).toBe(0x1a0);
    expect(v!.found!.fields).toHaveLength(1);
    // The field with its flags, or the word holding it (the flags then read as < 0.05 km/h): either reads the speed.
    const p = discoveredProfile("unknown", v!.found!);
    for (const kph of [0, 12.3, 50, 88.8]) {
      const data = new Array<number>(8).fill(0);
      speed.fill(data, kph, 3);
      expect(Math.abs(p.speed[0].read(data, 8) * 3.6 - kph)).toBeLessThan(0.1);
    }
  });

  it("rejects a batch whose ids carry no speed (counters, a gear, an rpm-like value that isn't linear)", () => {
    const other: Message = {
      id: 0x228,
      len: 8,
      fill: (d, kph, n) => {
        d[0] = n & 0xff;
        d[1] = kph > 0 ? 4 : 1;
        writeField({ byte: 2, endian: "be", shift: 0, bits: 16 }, d, Math.round(800 + 30 * Math.sqrt(kph) * 10));
      },
    };
    const v = run([other]).judge();
    expect(v).toEqual({ found: null });
  });

  it("an id heard standing that goes silent driving, and one whose frames change length, hold no batch up", () => {
    const wheels: Message = {
      id: 0x4b0,
      len: 8,
      fill: (d, kph) => [0, 2, 4, 6].forEach((byte) => writeField({ byte, endian: "be", shift: 0, bits: 16 }, d, Math.round((kph + 100) / 0.01))),
    };
    // A parking aid's message: only while the car stands at the start.
    const parking: Message = { id: 0x2a0, len: 8, untilS: 20, fill: (d, _kph, n) => (d[0] = n & 0xff) };
    // A first frame of 8 bytes, then 6.
    const odd: Message = { id: 0x2c0, len: (n) => (n < 3 ? 8 : 6), fill: (d, _kph, n) => (d[1] = n & 0xff) };
    const v = run([parking, odd, wheels]).judge();
    expect(v?.found?.id).toBe(0x4b0);
    expect(tidy(v!.found!.fields).map(fieldKey)).toEqual([0, 2, 4, 6].map((b) => `b${b}be16s0x0.01o10000`));
  });

  it("the profile reads the speed the car sent, the mean of its wheels", () => {
    const fields = tidy([0, 2, 4, 6].map((byte) => ({ byte, endian: "be" as const, shift: 0, bits: 16, kphPerCount: 0.01002, offset: 9996, r: 0.999 })));
    const p = discoveredProfile("unknown", { id: 0x4b0, len: 8, fields, pairs: 200, rangeKph: 60 });
    expect(p.key).toBe("found/4b0/8/b0be16s0x0.01o10000+b2be16s0x0.01o10000+b4be16s0x0.01o10000+b6be16s0x0.01o10000");
    const data = new Array<number>(8).fill(0);
    for (const byte of [0, 2, 4, 6]) writeField({ byte, endian: "be", shift: 0, bits: 16 }, data, 10000 + 5000);
    expect(p.speed[0].read(data, 8) * 3.6).toBeCloseTo(50, 6);
    expect(readField({ byte: 0, endian: "be", shift: 0, bits: 16 }, data)).toBe(15000);
  });

  it("the key is the whole layout: replay rebuilds the profile from a log's note", () => {
    const fields = tidy([{ byte: 3, endian: "le" as const, shift: 4, bits: 12, kphPerCount: 0.125, offset: 0, r: 0.999 }]);
    const p = discoveredProfile("unknown", { id: 0x1f1, len: 8, fields, pairs: 200, rangeKph: 60 });
    const back = foundProfile(p.key)!;
    expect(back.key).toBe(p.key);
    const data = [0, 0, 0, 0x40, 0x1f, 0, 0, 0];
    expect(back.speed[0].read(data, 8)).toBeCloseTo(p.speed[0].read(data, 8), 9);
    expect(foundProfile("mazda/mazda/mazda_2017")).toBeNull();
    expect(foundProfile("found/4b0/8/nonsense")).toBeNull();
  });
});
