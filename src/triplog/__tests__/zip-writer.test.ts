import { crc32, ZipWriter } from "@/triplog/zip-writer";

function build(files: { name: string; chunks: Uint8Array[] }[]) {
  const parts: Uint8Array[] = [];
  let closed = false;
  const zip = new ZipWriter({ write: (b) => parts.push(b.slice()), close: () => (closed = true) });
  for (const f of files) zip.addFile(f.name, new Date(2026, 9, 3, 14, 30, 12), f.chunks);
  zip.finish();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { out, closed };
}

/** Reads entries through the central directory, as unzip tools do. */
function read(zip: Uint8Array) {
  const v = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = zip.subarray(dataStart, dataStart + size);
    expect(v.getUint32(dataStart + size, true)).toBe(0x08074b50);
    entries.push({ name, crc, data, time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true) });
    p += 46 + nameLen;
  }
  return entries;
}

describe("ZipWriter", () => {
  test("crc32 check value", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc32(bytes)).toBe(0xcbf43926);
    expect(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4)))).toBe(0xcbf43926);
  });

  test("stores files from chunks; central directory points at them", () => {
    const a = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
    const { out, closed } = build([
      { name: "20261003-113012_abc123.ulg", chunks: [a.subarray(0, 65_536), a.subarray(65_536)] },
      { name: "empty.ulg", chunks: [] },
      { name: "поїздка.ulg", chunks: [new Uint8Array([1, 2, 3])] },
    ]);
    expect(closed).toBe(true);
    const entries = read(out);
    expect(entries.map((e) => e.name)).toEqual(["20261003-113012_abc123.ulg", "empty.ulg", "поїздка.ulg"]);
    expect(entries[0].data).toEqual(a);
    expect(entries[0].crc).toBe(crc32(a));
    expect(entries[1].data.length).toBe(0);
    expect(entries[1].crc).toBe(0);
    expect(Array.from(entries[2].data)).toEqual([1, 2, 3]);
    expect(entries[0].time).toBe((14 << 11) | (30 << 5) | 6);
    expect(entries[0].date).toBe((46 << 9) | (10 << 5) | 3);
  });

  test("empty archive is just the end record", () => {
    const { out } = build([]);
    expect(out.length).toBe(22);
    expect(read(out)).toEqual([]);
  });
});
