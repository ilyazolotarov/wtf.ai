// Simulated spoofing for replay (SPEC §3.10, NAVIGATOR-SPEC §13.6): inside a window the satellite fixes
// are replaced by a spoofed position, as a spoofer's transmitter (or a rebroadcast of real signals
// from elsewhere) makes every receiver around it report. Wi-Fi/cell fixes stay: spoofing doesn't move
// them (SPEC §3.3).
// - static: one place `distanceM` away at `bearingDeg` from where the car was when it began, standing
//   still (speed 0, no course) with a good accuracy, as a single-antenna spoofer gives;
// - outside: the same, at a place abroad (Minsk, unless `at` is given);
// - offset: the real fixes moved by `distanceM`: a spoofer that somehow follows the car. Unrealistic,
//   and once the car has driven it looks like dead reckoning that went wrong (integrity.ts).

import { LocalFrame } from "../geo/local-frame";
import { isSatelliteFix, type GnssFix } from "../types";

export interface SpoofWindow {
  /** Seconds since log start. */
  fromS: number;
  toS: number;
  kind: "static" | "outside" | "offset";
  /** static / offset: how far from the car, m (default 5 km), and in which direction (default east). */
  distanceM?: number;
  bearingDeg?: number;
  /** outside: where (default Minsk). */
  at?: { lat: number; lon: number };
  /** Reported accuracy of spoofed fixes, m (default 5). */
  hAccM?: number;
}

export const SPOOF_ABROAD = { lat: 53.9, lon: 27.56 };
const DEFAULT_SPOOF_DISTANCE_M = 5000;

/** The fixes with spoofing simulated in `windows`, and which of them are spoofed. */
export function spoofFixes(gnss: GnssFix[], startUs: number, windows: SpoofWindow[]): { fixes: GnssFix[]; spoofed: Set<GnssFix> } {
  const spoofed = new Set<GnssFix>();
  if (!windows.length) return { fixes: gnss, spoofed };
  const places = new Map<SpoofWindow, { lat: number; lon: number }>();
  const fixes = gnss.map((f) => {
    const t = (f.tUs - startUs) / 1e6;
    const w = windows.find((x) => t >= x.fromS && t < x.toS);
    if (!w || !isSatelliteFix(f)) return f;
    const d = w.distanceM ?? DEFAULT_SPOOF_DISTANCE_M;
    const b = ((w.bearingDeg ?? 90) * Math.PI) / 180;
    let p: { lat: number; lon: number };
    if (w.kind === "offset") {
      p = new LocalFrame(f).toCoordinate(d * Math.sin(b), d * Math.cos(b));
    } else {
      if (!places.has(w)) places.set(w, w.kind === "outside" ? (w.at ?? SPOOF_ABROAD) : new LocalFrame(f).toCoordinate(d * Math.sin(b), d * Math.cos(b)));
      p = places.get(w)!;
    }
    const out: GnssFix =
      w.kind === "offset"
        ? { ...f, lat: p.lat, lon: p.lon, hAccM: w.hAccM ?? f.hAccM }
        : { tUs: f.tUs, lat: p.lat, lon: p.lon, hAccM: w.hAccM ?? 5, speedMps: 0, speedAccMps: 0.3 };
    spoofed.add(out);
    return out;
  });
  return { fixes, spoofed };
}

/** `from:len[:kind[:distanceM[:bearingDeg]]]`, seconds and metres; kind static (default), outside or offset. */
export function parseSpoof(arg: string): SpoofWindow {
  const [from, len, kind = "static", distance, bearing] = arg.split(":");
  if (kind !== "static" && kind !== "outside" && kind !== "offset") throw new Error(`unknown spoof kind ${kind}`);
  const fromS = Number(from);
  const toS = len === "inf" ? Infinity : fromS + Number(len);
  return {
    fromS,
    toS,
    kind,
    ...(distance ? { distanceM: Number(distance) } : {}),
    ...(bearing ? { bearingDeg: Number(bearing) } : {}),
  };
}
