// Offline map releases (docs/UPDATES-SPEC.md §4): `maps/<osm_date>/` as tools/tiles wrote it, `maps/latest.json` names
// the current one.
import { MAPS_LATEST_KEY, mapFileKey, type MapsLatest } from "../../tools/ota/protocol";

import { json, readJson, type Env } from "./bucket";

/** How long the release before the current one stays: downloads that started on it finish. */
export const PREVIOUS_MAPS_KEPT_MS = 2 * 24 * 3600 * 1000;

/** PUT `/publish/maps/<osm_date>`: makes an uploaded release the current one. */
export async function publishMaps(env: Env, osmDate: string, now: Date): Promise<Response> {
  const index = await readJson<{ osm_date?: string }>(env.BUCKET, mapFileKey(osmDate, "index.json"));
  if (!index) return json(409, { error: `maps/${osmDate}/index.json is not uploaded` });
  if (index.osm_date !== osmDate) return json(400, { error: `index.json is for ${index.osm_date}, not ${osmDate}` });
  const current = await readJson<MapsLatest>(env.BUCKET, MAPS_LATEST_KEY);
  const previous =
    current && current.osm_date !== osmDate
      ? { osm_date: current.osm_date, until: new Date(now.getTime() + PREVIOUS_MAPS_KEPT_MS).toISOString() }
      : current?.previous;
  const latest: MapsLatest = { osm_date: osmDate, published: now.toISOString(), ...(previous ? { previous } : {}) };
  await env.BUCKET.put(MAPS_LATEST_KEY, JSON.stringify(latest), { httpMetadata: { contentType: "application/json" } });
  return json(201, latest);
}

export async function serveMapsLatest(env: Env): Promise<Response> {
  const stored = await env.BUCKET.get(MAPS_LATEST_KEY);
  if (!stored) return json(404, { error: "no maps published" });
  return new Response(stored.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" } });
}
