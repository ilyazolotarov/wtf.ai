// The 2026-10-06 rules checked against every trip log, on the dot the app itself published (`nav_estimate`),
// which is what each rule actually saw — a fresh single-trip replay cannot reproduce an error the app carried in
// from earlier trips, which is how that day's 10 km came about.
// Usage: npm run replay:doubt -- <trip.ulg...>
//   - position doubt (NAVIGATOR-SPEC §6.1a): would it have been raised, when, and how far out
//   - the "Set your position on the map" offer (§6.2): share of the published positions it is offered, against
//     the old `accuracyM > 75 m` rule, and what the `offroad` clause adds over it
//   - the follow camera's jump threshold (UI-SPEC §6.2): published steps over it

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { haversineM } from "../../src/nav/geo";
import { DEFAULT_NAV_CONFIG } from "../../src/nav/navigator";
import { isSatelliteFix } from "../../src/nav/types";
import { readTripLog } from "../../src/triplog/trip-log-reader";
import type { TripLog } from "../../src/triplog/trip-log-reader";

type NavRow = TripLog["navEstimate"][number];
type MmRow = TripLog["navMapMatch"][number];

/** `src/app/index.tsx`. */
const STANDING_MPS = 1;
const PLACE_OFFER_ACCURACY_M = 75;
const PLACE_OFFER_DISTANCE_M = 5000;
/** `map-surface.native.tsx`. */
const FOLLOW_JUMP_M = 80;

const C = DEFAULT_NAV_CONFIG;
const at = (r: NavRow) => ({ lat: r.latDeg, lon: r.lonDeg });
const pct = (n: number, d: number) => (d === 0 ? "    — " : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

interface Row {
  trip: string;
  satShare: number;
  fixes: number;
  doubtAtS: number | null;
  doubtMaxM: number;
  offerOld: number;
  offerOffroad: number;
  offerAll: number;
  standing: number;
  rows: number;
  jumps: number;
  jumpMaxM: number;
}

function run(file: string): Row {
  const trip = readTripLog(new Uint8Array(readFileSync(file)));
  const nav = trip.navEstimate;
  const mm = trip.navMapMatch;

  // The camera: consecutive published positions.
  let jumps = 0;
  let jumpMaxM = 0;
  for (let i = 1; i < nav.length; i++) {
    const d = haversineM(at(nav[i - 1]), at(nav[i]));
    if (d > FOLLOW_JUMP_M) {
      jumps++;
      jumpMaxM = Math.max(jumpMaxM, d);
    }
  }

  // The doubt: the navigator's own rule, over the dot it published at each coarse fix.
  let run = 0;
  let doubtAtS: number | null = null;
  let doubtMaxM = 0;
  let lastCoarse: { lat: number; lon: number } | null = null;
  let fixes = 0;
  const navAt = (tUs: number) => {
    let lo = 0;
    let hi = nav.length - 1;
    if (!nav.length || tUs < nav[0].tUs) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nav[mid].tUs <= tUs) lo = mid;
      else hi = mid - 1;
    }
    return nav[lo];
  };
  for (const f of trip.gnss) {
    if (isSatelliteFix(f)) {
      run = 0;
      continue;
    }
    // The gates in `Navigator.onGnss`: too coarse to weigh, or a repeat of the last one.
    if (f.hAccM > C.maxFixAccuracyM || !(f.hAccM > 0)) continue;
    if (lastCoarse && haversineM(lastCoarse, f) < C.coarseRepeatShare * f.hAccM) continue;
    lastCoarse = { lat: f.lat, lon: f.lon };
    const p = navAt(f.tUs);
    if (!p) continue;
    fixes++;
    const d = haversineM(at(p), f);
    if (d <= C.coarseDoubtShare * f.hAccM) {
      run = 0;
      continue;
    }
    if (++run >= C.coarseDoubtFixes) {
      doubtAtS ??= (f.tUs - trip.startUs) / 1e6;
      doubtMaxM = Math.max(doubtMaxM, d);
    }
  }

  // The offer, clause by clause, over every published position.
  const mmAt = (tUs: number): MmRow | null => {
    let lo = 0;
    let hi = mm.length - 1;
    if (!mm.length || tUs < mm[0].tUs) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (mm[mid].tUs <= tUs) lo = mid;
      else hi = mid - 1;
    }
    return mm[lo];
  };
  let offerOld = 0;
  let offerOffroad = 0;
  let offerAll = 0;
  let standingRows = 0;
  for (const p of nav) {
    const standing = !(p.speedMps > STANDING_MPS);
    if (!standing) continue;
    standingRows++;
    if (p.trust === "TRUSTED") continue;
    const rough = p.accuracyM > PLACE_OFFER_ACCURACY_M || !Number.isFinite(p.headingRad);
    const offroad = mmAt(p.tUs)?.state === "offroad";
    // `distanceSinceTrustedM` is not in the log, so this measures the `rough` and `offroad` clauses only.
    if (rough) offerOld++;
    else if (offroad) offerOffroad++;
    if (rough || offroad) offerAll++;
  }

  const sat = trip.gnss.filter(isSatelliteFix).length;
  return {
    trip: basename(file).replace(/\.ulg$/, "").replace(/_manual$/, "").slice(-6),
    satShare: trip.gnss.length ? sat / trip.gnss.length : 0,
    fixes,
    doubtAtS,
    doubtMaxM,
    offerOld,
    offerOffroad,
    offerAll,
    standing: standingRows,
    rows: nav.length,
    jumps,
    jumpMaxM,
  };
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!files.length) throw new Error("no trip log given");
const rows = files.map(run);
console.log(
  `${"trip".padEnd(8)}${"sat".padStart(6)} ${"coarse".padStart(7)}  ${"doubt@s".padStart(8)} ${"max m".padStart(7)}  ` +
    `${"offer".padStart(6)} ${"was".padStart(6)} ${"+offrd".padStart(7)}  ${"jumps".padStart(6)} ${"max m".padStart(8)}`,
);
for (const r of rows) {
  console.log(
    `${r.trip.padEnd(8)}${pct(r.satShare, 1)} ${String(r.fixes).padStart(7)}  ` +
      `${(r.doubtAtS === null ? "—" : r.doubtAtS.toFixed(0)).padStart(8)} ${(r.doubtMaxM ? Math.round(r.doubtMaxM) : "—").toString().padStart(7)}  ` +
      `${pct(r.offerAll, r.rows)} ${pct(r.offerOld, r.rows)} ${pct(r.offerOffroad, r.rows)}  ` +
      `${String(r.jumps).padStart(6)} ${Math.round(r.jumpMaxM).toString().padStart(8)}`,
  );
}
const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
console.log(
  `\n${rows.length} drives, ${sum((r) => r.rows)} published positions, ${sum((r) => r.fixes)} coarse fixes weighed.` +
    `\n  doubt raised on ${rows.filter((r) => r.doubtAtS !== null).length}: ${rows.filter((r) => r.doubtAtS !== null).map((r) => `${r.trip}@${r.doubtAtS!.toFixed(0)}s/${Math.round(r.doubtMaxM)}m`).join(", ") || "none"}` +
    `\n  offer ${pct(sum((r) => r.offerAll), sum((r) => r.rows))} of positions (was ${pct(sum((r) => r.offerOld), sum((r) => r.rows))}), standing ${pct(sum((r) => r.standing), sum((r) => r.rows))}` +
    `\n  camera jumps ${sum((r) => r.jumps)}, largest ${Math.round(Math.max(...rows.map((r) => r.jumpMaxM)))} m`,
);
