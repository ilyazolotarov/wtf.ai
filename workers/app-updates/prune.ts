// Keeps the bucket within R2's free 10 GB (docs/UPDATES-SPEC.md §2.1): removes the builds, JS updates and map releases
// no phone needs. Run by the daily cron and by the CLIs after a publish, each time as a request of its own, so a
// failed prune never fails a publish. Never touches what a `latest` points at, and leaves files of a publish in
// progress alone (younger than a day).
import { isPlatform, MAPS_LATEST_KEY, PLATFORMS, type MapsLatest, type Platform, type UpdateManifestRef } from "../../tools/ota/protocol";

import { deleteKeys, listAll, readJson, type Env, type R2Object } from "./bucket";

export const KEEP_BUILDS = 3;
export const KEEP_RUNTIMES = 3;
/** Files no kept record names are removed only after this: an upload whose record isn't written yet is younger. */
export const STRAY_AGE_MS = 24 * 3600 * 1000;
/** A map release newer than the current one is an upload on its way, unless nothing in it is this recent. */
const ABANDONED_MAPS_MS = 2 * 24 * 3600 * 1000;

const BUILD_RECORD_RE = /^apps\/(ios|android)\/(\d+)\.json$/;

/** The keys to remove from `apps/<platform>/`. */
function pruneApps(objects: R2Object[], platform: Platform, now: Date): string[] {
  const records = objects
    .map((o) => ({ o, m: BUILD_RECORD_RE.exec(o.key) }))
    .filter((r): r is { o: R2Object; m: RegExpExecArray } => !!r.m)
    .sort((a, b) => Number(b.m[2]) - Number(a.m[2]));
  const ext = platform === "ios" ? "ipa" : "apk";
  const keep = new Set([`apps/${platform}/latest.json`]);
  for (const { o, m } of records.slice(0, KEEP_BUILDS)) {
    keep.add(o.key);
    keep.add(`apps/${platform}/wtfai-${m[2]}.${ext}`);
  }
  const dropped = new Set(records.slice(KEEP_BUILDS).flatMap(({ o, m }) => [o.key, `apps/${platform}/wtfai-${m[2]}.${ext}`]));
  return objects
    .filter((o) => !keep.has(o.key) && (dropped.has(o.key) || now.getTime() - o.uploaded.getTime() > STRAY_AGE_MS))
    .map((o) => o.key);
}

/** The keys to remove of the JS updates: runtimes not kept, old records, files no kept record uses. */
async function pruneUpdates(env: Env, now: Date): Promise<string[]> {
  const builds = await listAll(env.BUCKET, "builds/");
  const latest = await listAll(env.BUCKET, "latest/");
  // A runtime's age: its build's registration or its latest publish, whichever is newer.
  const touched = new Map<string, number>();
  for (const o of [...builds, ...latest]) {
    const [, runtime, file] = o.key.split("/");
    const target = `${runtime}/${file.replace(/\.json$/, "")}`;
    touched.set(target, Math.max(touched.get(target) ?? 0, o.uploaded.getTime()));
  }
  const kept = new Set<string>();
  for (const platform of PLATFORMS) {
    [...touched]
      .filter(([target]) => target.endsWith(`/${platform}`))
      .sort((a, b) => b[1] - a[1])
      .slice(0, KEEP_RUNTIMES)
      .forEach(([target]) => kept.add(target));
  }
  const remove: string[] = [];
  const isKept = (runtime: string, platform: string) => isPlatform(platform) && kept.has(`${runtime}/${platform}`);
  for (const o of builds) {
    const [, runtime, file] = o.key.split("/");
    if (!isKept(runtime, file.replace(/\.json$/, ""))) remove.push(o.key);
  }

  // The latest record of each kept runtime (a copy of it is `latest/`): the one phones get, and the files it uses.
  const latestIds = new Map<string, string>();
  const used = new Set<string>();
  for (const o of latest) {
    const [, runtime, file] = o.key.split("/");
    const target = `${runtime}/${file.replace(/\.json$/, "")}`;
    if (!kept.has(target)) {
      remove.push(o.key);
      continue;
    }
    const record = await readJson<{ id?: string; manifest?: string }>(env.BUCKET, o.key);
    if (!record?.id) continue;
    latestIds.set(target, record.id);
    if (!record.manifest) continue;
    const m = JSON.parse(record.manifest) as UpdateManifestRef;
    for (const a of [m.launchAsset, ...m.assets]) used.add(a.key);
  }
  for (const o of await listAll(env.BUCKET, "updates/")) {
    const [, runtime, platform] = o.key.split("/");
    if (!isKept(runtime, platform) || o.key !== `updates/${runtime}/${platform}/${latestIds.get(`${runtime}/${platform}`)}.json`) {
      remove.push(o.key);
    }
  }
  for (const o of await listAll(env.BUCKET, "assets/")) {
    if (!used.has(o.key.slice("assets/".length)) && now.getTime() - o.uploaded.getTime() > STRAY_AGE_MS) remove.push(o.key);
  }
  return remove;
}

/** The keys to remove of the map releases: all but the current one and, until its time is up, the one before. */
async function pruneMaps(env: Env, now: Date): Promise<string[]> {
  const latest = await readJson<MapsLatest>(env.BUCKET, MAPS_LATEST_KEY);
  if (!latest?.osm_date) return [];
  const keepDates = new Set([latest.osm_date]);
  if (latest.previous && now.getTime() < Date.parse(latest.previous.until)) keepDates.add(latest.previous.osm_date);
  const byDate = new Map<string, R2Object[]>();
  for (const o of await listAll(env.BUCKET, "maps/")) {
    if (o.key === MAPS_LATEST_KEY) continue;
    const date = o.key.split("/")[1];
    byDate.set(date, [...(byDate.get(date) ?? []), o]);
  }
  const remove: string[] = [];
  for (const [date, objects] of byDate) {
    if (keepDates.has(date)) continue;
    const newest = Math.max(...objects.map((o) => o.uploaded.getTime()));
    if (date > latest.osm_date && now.getTime() - newest < ABANDONED_MAPS_MS) continue;
    remove.push(...objects.map((o) => o.key));
  }
  return remove;
}

/** Removes (or with `dry`, only lists) what no phone needs. */
export async function prune(env: Env, now: Date, dry = false): Promise<string[]> {
  const remove: string[] = [];
  for (const platform of PLATFORMS) remove.push(...pruneApps(await listAll(env.BUCKET, `apps/${platform}/`), platform, now));
  remove.push(...(await pruneUpdates(env, now)));
  remove.push(...(await pruneMaps(env, now)));
  if (!dry) await deleteKeys(env.BUCKET, remove);
  return remove;
}
