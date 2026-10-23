// Discovery (VEHICLE-LINK-SPEC §16.6) on recorded drives: the app's search for a speed field among the ids the log's
// monitor heard (src/nav/odometry/can/discovery.ts), fed the frames and the OBD polls in time order, as if the car
// had no profile. Only stretches with both count: a log made with CAN primary has OBD speed only while standing.
// With `--order`, a find of four wheels then gets its order from the phone's gyro (wheel-order.ts), over the whole log
// (as on a drive after the find), checked against the log's own profile where it reads wheels on that id.
//
//   npm run replay:discover -- tools/triplog/logs/*.ulg
//   npm run replay:discover -- trip.ulg --ids 228,82,78      # only these ids (hex), as one batch
//   npm run replay:discover -- logs… --order                 # and which wheel is which
//   npm run replay:discover -- logs… --order --carry         # a car's drives adding up until a verdict, as the app
//   npm run replay:discover -- logs… --order --find found/215/8/b0be16s0x0.01o10000+…   # no search: this find
import { readFileSync } from "node:fs";
import path from "node:path";

import { CanSpeedAverager } from "../../src/nav/odometry/can/can-speed";
import { fieldKey, fieldSpeeds, foundKey, foundSpeed, SpeedFieldFinder, tidy, type DiscoveredSpeed } from "../../src/nav/odometry/can/discovery";
import { retimeFrames } from "../../src/nav/odometry/can/frame-timing";
import { WheelOrderFinder, type WheelOrder, type WheelOrderSums } from "../../src/nav/odometry/can/wheel-order";
import { ImuProcessor } from "../../src/nav/odometry/imu/imu-processor";
import { busTimedFrames, decodeTripCan } from "../../src/nav/replay/can";
import { readTripLog, type TripLog } from "../../src/triplog/trip-log-reader";

const args = process.argv.slice(2);
const idsAt = args.indexOf("--ids");
const only = idsAt >= 0 ? args[idsAt + 1].split(",").map((h) => parseInt(h, 16)) : null;
const findAt = args.indexOf("--find");
const given = findAt >= 0 ? foundSpeed(args[findAt + 1]) : null;
const order = args.includes("--order") || given !== null;
const carry = args.includes("--carry");
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ids" && args[i - 1] !== "--find");
if (!files.length || (findAt >= 0 && !given)) {
  console.error("usage: npm run replay:discover -- <logs> [--ids <hex,…>] [--order [--carry]] [--find <found/… key>]");
  process.exit(1);
}

const WHEELS = ["fl", "fr", "rl", "rr"];
/** What a car's drives learned of its find's order (`--carry`): VIN → the find's key and the sums. */
const carried = new Map<string, { key: string; sums: WheelOrderSums }>();
const tally = { right: 0, wrong: 0, notWheels: 0, undecided: 0, noTruth: 0 };

for (const file of files) {
  const name = path.basename(file);
  let trip;
  try {
    trip = readTripLog(new Uint8Array(readFileSync(file)));
  } catch (e) {
    console.log(`${name}: unreadable (${(e as Error).message})`);
    continue;
  }
  if (!trip.can?.length) continue;
  const frames = retimeFrames(busTimedFrames(trip), trip.canWindows ?? []).filter((f) => !only || only.includes(f.id));
  if (given) {
    if (frames.some((f) => f.id === given.id)) console.log(`${name}: ${wheelOrder(trip, given, frames)}`);
    continue;
  }
  const ids = [...new Set(frames.map((f) => f.id))];
  const obd = trip.obdSpeed.filter((s) => s.source !== "can");
  const finder = new SpeedFieldFinder(ids);
  let i = 0;
  let readyS: number | null = null;
  let verdict: ReturnType<SpeedFieldFinder["judge"]> = null;
  // Judged when the app would: as soon as the batch is ready.
  for (const f of frames) {
    while (i < obd.length && obd[i].tUs <= f.tUs) {
      finder.addObd(obd[i].tUs, obd[i].rawKph);
      i++;
    }
    finder.addFrame(f.id, f.tUs, f.data);
    verdict = finder.judge();
    if (verdict) {
      readyS = (f.tUs - trip.startUs) / 1e6;
      break;
    }
  }
  const d = verdict?.found ?? null;
  const head = `${name} ids ${ids.map((id) => id.toString(16)).join(" ")}`;
  if (!d) console.log(`${head}: nothing found${readyS === null ? " (no verdict by the log's end)" : ""}`);
  else
    console.log(
      `${head}: ${d.id.toString(16)} ${d.fields.length} field(s) ${tidy(d.fields).map((f) => `${fieldKey(f)} r ${f.r.toFixed(4)}`).join(", ")}; ` +
        `${d.pairs} pairs, range ${d.rangeKph.toFixed(0)} km/h, decided at ${readyS?.toFixed(0) ?? "-"} s`,
    );
  if (order && d?.fields.length === 4) console.log(`  ${wheelOrder(trip, d, frames)}`);
}

if (order) {
  const t = tally;
  console.log(`order: ${t.right} right, ${t.wrong} wrong, ${t.notWheels} not four wheels, ${t.undecided} undecided, ${t.noTruth} without a profile to check`);
}

/** The gyro's verdict on the find's order over the log, as `CanWheelOrder` reaches it. */
function wheelOrder(trip: TripLog, d: DiscoveredSpeed, frames: { id: number; tUs: number; data: number[] }[]): string {
  const vin = String(trip.info.vehicle_vin ?? name(trip));
  const key = foundKey(d);
  const before = carry ? carried.get(vin) : undefined;
  const learner = new WheelOrderFinder(before?.key === key ? before.sums : null);
  const read = fieldSpeeds(d);
  const averager = new CanSpeedAverager();
  const gyro = new ImuProcessor();
  let k = 0;
  let stretches = learner.stretches;
  let found: ReturnType<WheelOrderFinder["verdict"]> = null;
  let atS = 0;
  const judge = (tUs: number) => {
    if (found || learner.stretches === stretches) return;
    stretches = learner.stretches;
    found = learner.verdict();
    atS = (tUs - trip.startUs) / 1e6;
  };
  for (const f of frames) {
    if (f.id !== d.id) continue;
    for (; k < trip.imu.length && trip.imu[k].tUs <= f.tUs; k++) {
      const o = gyro.process(trip.imu[k]);
      learner.addGyro(trip.imu[k].tUs, o.valid ? o.yawRate : null);
      judge(trip.imu[k].tUs);
    }
    const v = read(f.data, f.data.length);
    if (!v) continue;
    for (const c of averager.push({ q: "wheels", tUs: f.tUs, v: v as [number, number, number, number] })) learner.addFields(c.tUs, c.wheelsMps!);
    judge(f.tUs);
  }
  const minutes = ((learner.stretches * 5) / 60).toFixed(1);
  const fields = learner.fitted()?.fields;
  const fit = fields ? ` (sides ${fields.map((x) => x.sideT.toFixed(0)).join("/")}, axles ${fields.map((x) => x.axleT.toFixed(0)).join("/")} σ)` : "";
  const truth = truthOrder(trip, d);
  if (carry) carried.set(vin, { key, sums: learner.sums });
  const v = found as ReturnType<WheelOrderFinder["verdict"]>;
  if (!v) {
    tally.undecided++;
    return `order: undecided after ${minutes} min at 11 km/h or more${fit}`;
  }
  if (carry) carried.delete(vin);
  if (!v.order) {
    tally.notWheels++;
    return `order: not four wheels (${v.reason}) at ${atS.toFixed(0)} s${fit}`;
  }
  const named = v.order.map((field, w) => `${WHEELS[w]} ${field}`).join(" ");
  const check = truth ? (truth.every((x, w) => x === v.order![w]) ? "right" : `WRONG (the profile: ${truth.join("")})`) : "no profile to check";
  if (!truth) tally.noTruth++;
  else if (check === "right") tally.right++;
  else tally.wrong++;
  return (
    `order: ${named} at ${atS.toFixed(0)} s, track ${v.trackM.toFixed(2)} m (front ${v.frontTrackM.toFixed(2)}), ` +
    `wheelbase ${v.wheelbaseM.toFixed(2)} m, ${minutes} min by the log's end${fit}: ${check}`
  );
}

/**
 * The field of each wheel by the log's own profile, where it reads all four wheels from the find's id: each wheel's
 * lead over the four's mean against each field's (a find's step may be a few per cent off the profile's).
 */
function truthOrder(trip: TripLog, d: DiscoveredSpeed): WheelOrder | null {
  const p = decodeTripCan(trip)?.profile;
  if (!p?.wheels || p.wheels.some((w) => w.id !== d.id)) return null;
  const read = fieldSpeeds(d);
  const lead = (v: number[]) => {
    const mean = (v[0] + v[1] + v[2] + v[3]) / 4;
    return v.map((x) => x - mean);
  };
  const err = p.wheels.map(() => [0, 0, 0, 0]);
  for (const f of trip.can ?? []) {
    if (f.id !== d.id) continue;
    const v = read(f.data, f.data.length);
    if (!v) continue;
    const field = lead(v);
    const wheel = lead(p.wheels.map((w) => w.read(f.data, f.data.length)));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) err[i][j] += Math.abs(field[j] - wheel[i]);
  }
  const order = err.map((e) => e.indexOf(Math.min(...e))) as WheelOrder;
  return new Set(order).size === 4 ? order : null;
}

function name(trip: TripLog): string {
  return String(trip.info.trip_id ?? "");
}
