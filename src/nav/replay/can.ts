// A trip log's CAN shadow frames decoded through the car's profile (SPEC §2.1: decoded in replay).
import { CarStateDecoder, type CarStateSample } from "../odometry/can/car-state";
import { matchProfiles, profileByKey, type Profile, type ProfileMatch, type SeenId } from "../odometry/can/profile";
import type { TripLog } from "../../triplog/trip-log-reader";

export interface TripCan {
  /** Profiles that fit the frames, best first (only the VIN's make when the log has a VIN). */
  matches: ProfileMatch[];
  profile: Profile | null;
  samples: CarStateSample[];
  /** Ids the shadow listened for (from the log's `can_shadow`), or null when it isn't known. */
  listened: Set<number> | null;
  seen: Map<number, SeenId>;
}

export function listenedIds(trip: TripLog): Set<number> | null {
  const text = String(trip.info.can_shadow ?? "");
  const ids = text.split(/[\s,;]+/).filter((p) => /^(0x)?[0-9a-f]{1,8}$/i.test(p));
  return ids.length ? new Set(ids.map((p) => parseInt(p.replace(/^0x/i, ""), 16))) : null;
}

export function seenIds(frames: { id: number; data: number[] }[]): Map<number, SeenId> {
  const lens = new Map<number, Map<number, number>>();
  for (const f of frames) {
    let byLen = lens.get(f.id);
    if (!byLen) lens.set(f.id, (byLen = new Map()));
    byLen.set(f.data.length, (byLen.get(f.data.length) ?? 0) + 1);
  }
  const out = new Map<number, SeenId>();
  for (const [id, byLen] of lens) {
    let best = { len: 0, n: -1 };
    let frames = 0;
    for (const [len, n] of byLen) {
      frames += n;
      if (n > best.n) best = { len, n };
    }
    out.set(id, { frames, len: best.len });
  }
  return out;
}

/** Null when the log has no CAN frames. `profileKey` overrides the choice ("make/mapping/dbc"). */
export function decodeTripCan(trip: TripLog, profileKey?: string): TripCan | null {
  const frames = trip.can;
  if (!frames?.length) return null;
  const seen = seenIds(frames);
  const listened = listenedIds(trip);
  const vin = typeof trip.info.vehicle_vin === "string" ? trip.info.vehicle_vin : null;
  const matches = matchProfiles(seen, vin, listened ?? undefined);
  const profile = profileKey ? profileByKey(profileKey) : (matches[0]?.profile ?? null);
  const samples: CarStateSample[] = [];
  if (profile) {
    const decoder = new CarStateDecoder(profile);
    for (const f of frames) for (const s of decoder.push(f.tUs, f.id, f.data)) samples.push(s);
  }
  return { matches, profile, samples, listened, seen };
}
