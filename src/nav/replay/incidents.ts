// What a driver would see go wrong with the dot, moment by moment, against where the car really was (MAPMATCH-SPEC
// §10.3). Medians and percentiles over a drive hide a dot that points the wrong way for a second and a half or runs
// 30 m down the wrong end of a street after a turn: twenty clean minutes drown it. Here each such moment is an
// incident of its own, with its time, so a drive is judged by what went wrong in it, and a report links to the
// second to look at. Pure TS; times are seconds since log start.
//
// The truth is a path the car drove and where on it the car was when (`DrawnTruthTrack`): drawn in the viewer and
// timed by the odometer (± its doubt), or a simulated drive's exact one (doubt 0).

import { bearingRad, haversineM, type Coordinate } from "../geo";
import { nearestOnPath, pointAlong, type DrawnTruthTrack } from "./drawn-truth";

export type IncidentKind = "lost" | "wrong-way" | "heading" | "wrong-road" | "far" | "jump" | "backwards";

/** One incident: when, and how bad at worst (m, or degrees for the heading kinds). */
export interface Incident {
  kind: IncidentKind;
  fromS: number;
  toS: number;
  worst: number;
  /** Plain enough for a driver to see on the map; the minor ones are worth a look, not a failed drive. */
  major: boolean;
  /** Inside a `lost` stretch: a consequence of being lost, not a failure of its own. */
  whileLost?: boolean;
}

/** How much of the drive was judged: a drive with no dots has no incidents, and must not pass for it. */
export interface IncidentCoverage {
  /** Truth samples with a dot to judge, and those with the car moving, s. */
  scoredS: number;
  movingS: number;
  /** Seconds the truth covers. */
  truthS: number;
  /** The dot to where the car was, while moving: median and worst, m. */
  errorMedianM: number | null;
  errorMaxM: number | null;
  /**
   * Where a clean satellite fix put the car more than `DISPUTE_M` from the drawn path (the car went another way than
   * drawn), or from where the drawing's timing has it (beyond twice its doubt): nothing is judged there; [from, to] s,
   * for whoever drew it to look at.
   */
  disputed: [number, number][];
}

export interface IncidentReport {
  incidents: Incident[];
  coverage: IncidentCoverage;
  /** Why the drive can't be judged against this truth (then no incidents, and it must not pass for clean). */
  unjudged?: string;
}

/** The dot as the app drew it: where, and which way its arrow pointed (undefined: no arrow). */
export interface DotSample {
  t: number;
  lat: number;
  lon: number;
  headingRad?: number;
}

/** A clean satellite fix (`CLEAN_FIX_M` or better, within `FIX_NEAR_S` of the moment) this far from the drawn path. */
const DISPUTE_M = 40;
const CLEAN_FIX_M = 10;
const FIX_NEAR_S = 1;

/** Lost: the dot farther than this from where the car is (plus twice the timing's doubt), for at least `LOST_S`. */
const LOST_M = 100;
const LOST_S = 20;
/** Sampling step over the truth, s: a flip lasting a second spans five samples. */
export const INCIDENT_STEP_S = 0.2;
/** The car is moving: the heading kinds only count then (a standing car's dot has no direction to be wrong in). */
const MOVING_MPS = 3;
/** The arrow against the car: more than this off its heading, for at least `WRONG_WAY_S`. */
const WRONG_WAY_DEG = 120;
const WRONG_WAY_S = 0.6;
/** The arrow well off the car's heading (holding the old road through a turn, a sideways road), this long. */
const HEADING_DEG = 60;
const HEADING_S = 1.5;
/** Farther than this from every part of the path near the car: another road, or through the blocks. */
const WRONG_ROAD_M = 30;
const WRONG_ROAD_S = 2;
const WRONG_ROAD_MAJOR_S = 5;
const WRONG_ROAD_MAJOR_M = 60;
/**
 * On the dot's road but away from the car, beyond this plus twice the timing's doubt, this long: along the path, and
 * as the crow flies too. Round a tight loop or a hairpin a point 13 m from the car is 90 m on along the path, and the
 * driver sees 13 m.
 */
const FAR_M = 30;
const FAR_S = 1;
const FAR_MAJOR_M = 50;
/** A step of the dot longer than the car went in it, by more than this: a jump; major beyond the second. */
const JUMP_M = 15;
const JUMP_MAJOR_M = 30;
/**
 * The dot on the path going back along it while the car goes forward, by this much within `BACKWARDS_WINDOW_S` —
 * and as far from where it was: on a loop its nearest place on the path can flip back a whole lap while it barely moves.
 */
const BACKWARDS_M = 8;
const BACKWARDS_MAJOR_M = 15;
const BACKWARDS_WINDOW_S = 1.5;
/** The dot counts as on the path this close to it (the lane, the drawing). */
const ON_PATH_M = 15;
/** How far along the path from the car the dot's road is looked for. */
const REACH_M = 300;
/** The truth's heading is taken over the timing's doubt along the path, up to this. */
const HEADING_DOUBT_CAP_M = 25;
/** A dot this much behind the car (beyond the doubt) is lagging, and may point the way its own stretch goes. */
const LAG_SLACK_M = 5;
/** ... and this close to the path: on its road, not just off a corner of it. */
const LAG_ON_PATH_M = 8;
/** Flagged moments this close in time are one incident. */
const MERGE_GAP_S = 1;
/**
 * Lost stretches this close in time are one: a dot lost for minutes that comes within `LOST_M` of the car for a few
 * seconds now and then is lost all along to the driver, not lost again each time (a jammed drive read as 30 losses
 * and their jumps).
 */
const LOST_MERGE_GAP_S = 30;
/**
 * The truth's timing is the odometer's (drawn truth): with an odometer this much shorter than the path (no OBD speed
 * logged), where the car was when is unknown.
 */
const MIN_ODOMETER_SHARE = 0.5;
/** No dot this long before a moment: nothing drawn, nothing to judge. */
const DOT_GAP_S = 2;

const DEG = 180 / Math.PI;
const angleDeg = (a: number, b: number) => Math.abs(((((a - b) * DEG) % 360) + 540) % 360 - 180);

/** The path's direction at `s`, over a few metres either side (a drawn path's corners are single points). */
function pathBearing(truth: DrawnTruthTrack, s: number): number {
  const [aLat, aLon] = pointAlong(truth.path, truth.cum, Math.max(0, s - 3));
  const [bLat, bLon] = pointAlong(truth.path, truth.cum, Math.min(truth.pathM, s + 3));
  return bearingRad({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
}

/** Stretches of path searched one by one for the dot: a route that passes a place twice has a hit in each. */
const PASS_WINDOW_M = 40;

/**
 * Where on the path the dot is: of the stretches within `reach` of the car (at `s`) that the dot is on (within
 * `ON_PATH_M`), the one nearest the car along the path; else the nearest point. A route looping round a block passes
 * a place twice 80 m apart along it and 5 m apart on the map: the nearest point alone put a dot right on the car's
 * road 80 m behind it, on the earlier pass.
 */
function nearestPass(truth: DrawnTruthTrack, dot: DotSample, s: number, reach: number): { s: number; distanceM: number } | null {
  let nearest: { s: number; distanceM: number } | null = null;
  let onPath: { s: number; distanceM: number } | null = null;
  for (let from = Math.max(0, s - reach); from < Math.min(truth.pathM, s + reach); from += PASS_WINDOW_M) {
    const hit = nearestOnPath(truth.path, truth.cum, dot, from, Math.min(from + PASS_WINDOW_M, s + reach));
    if (!hit) continue;
    if (!nearest || hit.distanceM < nearest.distanceM) nearest = hit;
    if (hit.distanceM <= ON_PATH_M && (!onPath || Math.abs(hit.s - s) < Math.abs(onPath.s - s))) onPath = hit;
  }
  return onPath ?? nearest;
}

/** The last dot at or before `t`, or null if none came within `DOT_GAP_S`. */
function dotAt(dots: readonly DotSample[], t: number, from: number): { dot: DotSample | null; index: number } {
  let i = from;
  while (i + 1 < dots.length && dots[i + 1].t <= t) i++;
  const d = dots[i];
  return { dot: d && d.t <= t && t - d.t <= DOT_GAP_S ? d : null, index: i };
}

interface Flag {
  kind: IncidentKind;
  t: number;
  value: number;
  /** For `far`: the threshold for major at this moment (the timing's doubt moves it). */
  majorAt?: number;
}

/**
 * The incidents of one drive: the dot (as drawn, `dots` in time order) against the truth. Samples the truth every
 * `INCIDENT_STEP_S` (its `points` should be that fine; `drawnTruthTrack(trip, drawn, INCIDENT_STEP_S)`).
 */
export function findIncidents(
  truth: DrawnTruthTrack,
  dots: readonly DotSample[],
  /** Satellite fixes (t s, accuracy m): a drawing a clean one disagrees with isn't judged there. Simulated truth: none. */
  fixes: readonly { t: number; lat: number; lon: number; hAccM: number }[] = [],
): IncidentReport {
  const flags: Flag[] = [];
  const clean = fixes.filter((f) => f.hAccM <= CLEAN_FIX_M);
  const disputed: [number, number][] = [];
  let fi = 0;
  const pts = truth.points;
  const errors: number[] = [];
  let scored = 0;
  const step = pts.length > 1 ? pts[1][0] - pts[0][0] : INCIDENT_STEP_S;
  const report = (incidents: Incident[]): IncidentReport => {
    errors.sort((a, b) => a - b);
    return {
      incidents,
      coverage: {
        scoredS: Math.round(scored * step),
        movingS: Math.round(errors.length * step),
        truthS: Math.round(pts.length * step),
        errorMedianM: errors.length ? Math.round(errors[Math.floor(errors.length / 2)]) : null,
        errorMaxM: errors.length ? Math.round(errors.at(-1)!) : null,
        disputed: disputed.map(([a, b]) => [Math.round(a * 10) / 10, Math.round((b + step) * 10) / 10]),
      },
    };
  };
  if (pts.length < 2 || !dots.length) return report([]);
  if (truth.doubtM > 0 && truth.pathM > 200 && truth.odometerM < MIN_ODOMETER_SHARE * truth.pathM) {
    return { ...report([]), unjudged: `odometer ${Math.round(truth.odometerM)} m for a ${Math.round(truth.pathM)} m path: no timing` };
  }
  const half = Math.max(1, Math.round(0.5 / step));
  let di = 0;
  // Backwards: recent dots on the path, (t, s along it).
  const onPath: { t: number; s: number; dot: Coordinate }[] = [];
  let prevDot: DotSample | null = null;
  let prevCarS = 0;
  for (let k = 0; k < pts.length; k++) {
    const [t, lat, lon, s, doubt] = pts[k];
    // The drawing against a clean fix at this moment: off by more than a lane or two, it can't judge the dot here.
    while (fi + 1 < clean.length && clean[fi + 1].t <= t) fi++;
    const fix = [clean[fi], clean[fi + 1]].find((f) => f && Math.abs(f.t - t) <= FIX_NEAR_S);
    // Off the drawn roads, or on them but far from where the drawing's timing has the car (beyond its doubt).
    if (fix && ((nearestPass(truth, fix, s, REACH_M + 2 * doubt)?.distanceM ?? Infinity) > DISPUTE_M || haversineM(fix, { lat, lon }) > DISPUTE_M + 2 * doubt)) {
      const last = disputed.at(-1);
      if (last && t - last[1] <= MERGE_GAP_S) last[1] = t;
      else disputed.push([t, t]);
      prevDot = null;
      onPath.length = 0;
      continue;
    }
    const at = dotAt(dots, t, di);
    di = Math.max(0, at.index);
    const dot = at.dot;
    if (!dot) {
      prevDot = null;
      onPath.length = 0;
      continue;
    }
    const speed = (pts[Math.min(pts.length - 1, k + half)][3] - pts[Math.max(0, k - half)][3]) / ((Math.min(pts.length - 1, k + half) - Math.max(0, k - half)) * step);
    const moving = speed > MOVING_MPS;
    scored++;
    const errorM = haversineM(dot, { lat, lon });
    if (moving) errors.push(errorM);
    if (errorM > LOST_M + 2 * doubt) flags.push({ kind: "lost", t, value: errorM });
    const reach = REACH_M + 2 * doubt;
    const near = nearestPass(truth, dot, s, reach);
    const offM = near?.distanceM ?? Infinity;

    // Jumps: each new dot against the last, beyond how far the car went in between.
    if (prevDot && dot !== prevDot && dot.t - prevDot.t <= 1.5) {
      const excess = haversineM(prevDot, dot) - Math.abs(s - prevCarS) - JUMP_M;
      if (excess > 0) flags.push({ kind: "jump", t, value: excess + JUMP_M });
    }
    if (dot !== prevDot) {
      prevDot = dot;
      prevCarS = s;
    }

    if (offM > WRONG_ROAD_M) flags.push({ kind: "wrong-road", t, value: offM });
    else {
      // On the path: how far along it from the car, beyond the timing's doubt.
      const along = Math.min(Math.abs(near!.s - s), errorM);
      const allowed = FAR_M + 2 * doubt;
      if (along > allowed) flags.push({ kind: "far", t, value: along, majorAt: FAR_MAJOR_M + 2 * doubt });
    }

    if (moving && near && offM <= ON_PATH_M) {
      onPath.push({ t, s: near.s, dot });
      while (onPath.length && t - onPath[0].t > BACKWARDS_WINDOW_S) onPath.shift();
      const back = Math.max(...onPath.map((p) => Math.min(p.s - near.s, haversineM(p.dot, dot))));
      if (back >= BACKWARDS_M) flags.push({ kind: "backwards", t, value: back });
    } else onPath.length = 0;

    if (moving && dot.headingRad !== undefined && Number.isFinite(dot.headingRad)) {
      // The car's heading, over the timing's doubt along the path (capped): the least the arrow is off any of them.
      const span = Math.min(doubt, HEADING_DOUBT_CAP_M);
      let off = Infinity;
      for (let x = s - span; x <= s + span + 1e-9; x += 2) off = Math.min(off, angleDeg(dot.headingRad, pathBearing(truth, x)));
      // A dot behind the car on the path is also judged by the path where it is: lagging on the road before a turn,
      // it points the way that road goes. Not one at or past the car: at a corner that would excuse an arrow pointing
      // back along the road the car just left (the flip after a T-junction turn).
      if (near && offM <= LAG_ON_PATH_M && near.s < s - span - LAG_SLACK_M) off = Math.min(off, angleDeg(dot.headingRad, pathBearing(truth, near.s)));
      if (off > WRONG_WAY_DEG) flags.push({ kind: "wrong-way", t, value: off });
      else if (off > HEADING_DEG) flags.push({ kind: "heading", t, value: off });
    }
  }
  return report(mergeFlags(flags, step));
}

function mergeFlags(flags: Flag[], step: number): Incident[] {
  const byKind = new Map<IncidentKind, Flag[]>();
  for (const f of flags) (byKind.get(f.kind) ?? byKind.set(f.kind, []).get(f.kind)!).push(f);
  const out: Incident[] = [];
  for (const [kind, list] of byKind) {
    let run: Flag[] = [];
    const close = () => {
      if (!run.length) return;
      const fromS = run[0].t;
      const toS = run.at(-1)!.t + step;
      const durationS = toS - fromS;
      const worstFlag = run.reduce((a, b) => (b.value > a.value ? b : a));
      const worst = worstFlag.value;
      run = [];
      let keep = true;
      let major = false;
      switch (kind) {
        case "wrong-way":
          keep = durationS >= WRONG_WAY_S;
          major = true;
          break;
        case "heading":
          keep = durationS >= HEADING_S;
          break;
        case "wrong-road":
          keep = durationS >= WRONG_ROAD_S;
          major = durationS >= WRONG_ROAD_MAJOR_S || worst >= WRONG_ROAD_MAJOR_M;
          break;
        case "far":
          keep = durationS >= FAR_S;
          major = worst >= (worstFlag.majorAt ?? FAR_MAJOR_M);
          break;
        case "jump":
          major = worst >= JUMP_MAJOR_M;
          break;
        case "backwards":
          major = worst >= BACKWARDS_MAJOR_M;
          break;
        case "lost":
          keep = durationS >= LOST_S;
          major = true;
          break;
      }
      if (keep) out.push({ kind, fromS: round1(fromS), toS: round1(toS), worst: Math.round(worst), major });
    };
    for (const f of list) {
      if (run.length && f.t - run.at(-1)!.t > (kind === "lost" ? LOST_MERGE_GAP_S : MERGE_GAP_S)) close();
      run.push(f);
    }
    close();
  }
  // A heading incident inside a wrong-way one is the same moment: keep the worse.
  const wrongWay = out.filter((i) => i.kind === "wrong-way");
  const lost = out.filter((i) => i.kind === "lost");
  return out
    .filter((i) => i.kind !== "heading" || !wrongWay.some((w) => w.fromS <= i.toS && i.fromS <= w.toS))
    .map((i) => (i.kind !== "lost" && lost.some((l) => l.fromS <= i.fromS && i.fromS < l.toS) ? { ...i, whileLost: true } : i))
    .sort((a, b) => a.fromS - b.fromS);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** "wrong-way 249.4–250.9 s, 180°" */
export function describeIncident(i: Incident): string {
  const unit = i.kind === "wrong-way" || i.kind === "heading" ? "°" : " m";
  return `${i.whileLost ? "(lost) " : i.major ? "" : "(minor) "}${i.kind} ${i.fromS.toFixed(1)}–${i.toS.toFixed(1)} s, ${i.worst}${unit}`;
}
