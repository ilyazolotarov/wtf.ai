import { CanMonitorCollector, formatSurvey, parseCanIds, parseMonitorLine } from "@/obd/can-monitor";

describe("parseMonitorLine", () => {
  test("11-bit id with and without spaces", () => {
    expect(parseMonitorLine("2150A1B2C3D4E5F607", 3)).toBeNull(); // odd data digits
    expect(parseMonitorLine("2150A1B2C3D4E5F6071", 3)).toEqual({ id: 0x215, data: [0x0a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x71] });
    expect(parseMonitorLine("228 01 02", 3)).toEqual({ id: 0x228, data: [1, 2] });
    expect(parseMonitorLine("082", 3)).toEqual({ id: 0x82, data: [] });
  });

  test("29-bit id", () => {
    expect(parseMonitorLine("18FEF100 AA BB", 8)).toEqual({ id: 0x18fef100, data: [0xaa, 0xbb] });
  });

  test("not a frame", () => {
    expect(parseMonitorLine("STOPPED", 3)).toBeNull();
    expect(parseMonitorLine("21", 3)).toBeNull();
    expect(parseMonitorLine("215 00 00 00 00 00 00 00 00 00", 3)).toBeNull(); // 9 data bytes
  });
});

describe("CanMonitorCollector", () => {
  test("lines split across chunks, BUFFER FULL and STOPPED", () => {
    const frames: number[] = [];
    const c = new CanMonitorCollector(3, (f) => frames.push(f.id));
    c.push("2150102\r2280", 100);
    c.push("3\r215010", 200);
    c.push("3\rBUFFER FULL\rXYZ\r", 300);
    c.push("082\rSTOPPED\r\r>", 400);
    c.end(400);
    expect(frames).toEqual([0x215, 0x228, 0x215, 0x82]);
    const s = c.survey(2000);
    expect(s.frames).toBe(4);
    expect(s.bufferFull).toBe(1);
    expect(s.other).toBe(1);
    expect(s.ids.map((i) => [i.id, i.count, i.hz, i.lengths])).toEqual([
      [0x82, 1, 0.5, [0]],
      [0x215, 2, 1, [2]],
      [0x228, 1, 0.5, [1]],
    ]);
    expect(s.ids.find((i) => i.id === 0x215)?.last).toEqual([0x01, 0x03]);
    expect(formatSurvey(s)[0]).toBe("3 ids, 4 frames in 2.0 s (2/s, 26 chars/s), BUFFER FULL ×1, 1 other lines");
    expect(formatSurvey(s)[2]).toBe("215    1.0 Hz  2 B  01 03");
  });
});

describe("parseCanIds", () => {
  test("hex ids separated by spaces or commas", () => {
    expect(parseCanIds("215, 228 82;0x78 215")).toEqual([0x215, 0x228, 0x82, 0x78]);
    expect(parseCanIds("  ")).toBeNull();
    expect(parseCanIds("215 ATZ")).toBeNull();
  });
});
