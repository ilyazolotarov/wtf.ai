import { randomBytes } from "node:crypto";

import {
  CODE_LENGTH,
  CONSONANTS,
  formatCode,
  generateCode,
  normalizeCode,
  TRIP_FILE_RE,
  uploadKey,
  VOWELS,
} from "../upload-protocol";

const random = (n: number) => new Uint8Array(randomBytes(n));

describe("upload codes", () => {
  it("read like three short words a tester can type without switching keyboards", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode(random);
      expect(code).toHaveLength(CODE_LENGTH);
      expect(formatCode(code)).toMatch(/^([bcdfghjkmnprstvwz][aeiou][bcdfghjkmnprstvwz][aeiou][bcdfghjkmnprstvwz]-?){3}$/);
      expect(normalizeCode(formatCode(code))).toBe(code);
    }
  });

  it("use every letter of a slot evenly (no modulo bias)", () => {
    const first = new Map<string, number>();
    const second = new Map<string, number>();
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const code = generateCode(random);
      first.set(code[0], (first.get(code[0]) ?? 0) + 1);
      second.set(code[1], (second.get(code[1]) ?? 0) + 1);
    }
    expect(first.size).toBe(CONSONANTS.length);
    expect(second.size).toBe(VOWELS.length);
    for (const c of first.values()) expect(Math.abs(c - n / CONSONANTS.length) / (n / CONSONANTS.length)).toBeLessThan(0.2);
    for (const c of second.values()) expect(Math.abs(c - n / VOWELS.length) / (n / VOWELS.length)).toBeLessThan(0.1);
  });

  it("keep drawing when the bytes are rejected", () => {
    let call = 0;
    // First batch all 255 (rejected for both letter sets), then zeros.
    const code = generateCode((k) => new Uint8Array(k).fill(call++ === 0 ? 255 : 0));
    expect(formatCode(code)).toBe("babab-babab-babab");
  });

  it("are read however they are typed", () => {
    expect(formatCode("bakimtuvodsegap")).toBe("bakim-tuvod-segap");
    expect(normalizeCode("bakim-tuvod-segap")).toBe("bakimtuvodsegap");
    expect(normalizeCode(" BAKIM TUVOD SEGAP ")).toBe("bakimtuvodsegap");
    expect(normalizeCode("bakim-tuvod-sega")).toBeNull();
    expect(normalizeCode("bakim-tuvod-segal")).toBeNull();
    expect(normalizeCode("bakim-tuvod-sega1")).toBeNull();
  });
});

describe("upload keys", () => {
  it("accept only recorder file names", () => {
    expect(TRIP_FILE_RE.test("20261003-100247_ng2n9z.ulg")).toBe(true);
    expect(TRIP_FILE_RE.test("20261003-100247_ng2n9z_manual.ulg")).toBe(true);
    expect(TRIP_FILE_RE.test("../20261003-100247_ng2n9z.ulg")).toBe(false);
    expect(TRIP_FILE_RE.test("20261003-100247_ng2n9z.truth.json")).toBe(false);
  });

  it("keep testers' logs apart from the owner's", () => {
    const created = "2026-10-08T00:00:00Z";
    expect(uploadKey({ name: "me", owner: true, created }, "a.ulg")).toBe("logs/a.ulg");
    expect(uploadKey({ name: "tester-a", created }, "a.ulg")).toBe("logs/testers/tester-a/a.ulg");
  });
});
