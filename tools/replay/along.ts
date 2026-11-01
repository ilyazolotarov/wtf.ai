// Places to pull in at along a route (STOPS-SPEC §6.3), with their detours, from the command line: the same query and
// searches as the app's "On the way" page.
//
//   npm run along -- --graph kyiv-city.graph.bin --search kyiv-city.search.bin --from 50.457,30.38,90 --to 50.45,30.52 \
//     [--kind fuel] [--count 10] [--geojson out.geojson]

import { writeFileSync } from "node:fs";

import type { Coordinate } from "../../src/nav/geo";
import { LocalFrame } from "../../src/nav/geo/local-frame";
import { TiledRoadGraph } from "../../src/nav/mapmatch/graph/road-graph";
import { placesAlong, RouteLine } from "../../src/nav/routing/along";
import { DetourSearch } from "../../src/nav/routing/detour";
import { planRoute, type RouteStart } from "../../src/nav/routing/router";
import { SearchIndex, type PlaceCategory } from "../../src/nav/search/search-index";

import { fileByteSource } from "./graph-file";

const argv = process.argv.slice(2);
const take = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const point = (s: string | undefined): RouteStart | undefined => {
  if (!s) return undefined;
  const [lat, lon, heading] = s.split(",").map(Number);
  return { lat, lon, ...(Number.isFinite(heading) ? { headingRad: (heading * Math.PI) / 180, speedMps: 10 } : {}) };
};
const graphFile = take("--graph");
const searchFile = take("--search");
const from = point(take("--from"));
const to = point(take("--to")) as Coordinate | undefined;
const kind = (take("--kind") ?? "fuel") as PlaceCategory;
const count = Number(take("--count") ?? 10);
if (!graphFile || !searchFile || !from || !to) {
  console.error("usage: npm run along -- --graph <graph.bin> --search <search.bin> --from lat,lon[,heading] --to lat,lon [--kind fuel] [--count 10] [--geojson out]");
  process.exit(2);
}

const frame = new LocalFrame(from);
const graph = new TiledRoadGraph(fileByteSource(graphFile), frame);
const index = new SearchIndex(fileByteSource(searchFile));
const r = planRoute(graph, frame, from, to);
if (r.status !== "done") throw new Error(`no route: ${r.reason}`);
const line = new RouteLine(r.plan);
const t0 = performance.now();
const found = placesAlong(line, 0, (box) => index.placesIn(box, new Set([kind])), { count });
const t1 = performance.now();
const search = new DetourSearch(graph, frame, line, 0, found.hits.map((h) => ({ key: h.place.key, point: h.place, alongM: h.alongM })));
let out = search.run();
const detours = new Map(out.results.map((x) => [x.key, x.detourS]));
while (!out.done) {
  out = search.run();
  out.results.forEach((x) => detours.set(x.key, x.detourS));
}
const t2 = performance.now();
console.log(`route ${(r.plan.lengthM / 1000).toFixed(1)} km; ${found.hits.length} ${kind} places in ${(t1 - t0).toFixed(1)} ms, detours in ${(t2 - t1).toFixed(0)} ms${found.more ? "; more further on" : ""}`);
for (const h of found.hits) {
  const d = detours.get(h.place.key);
  console.log(
    `  ${(h.alongM / 1000).toFixed(2).padStart(6)} km  ${(h.side ?? "on it").padEnd(5)}  ${String(Math.round(h.offM)).padStart(3)} m off  ` +
      `${d == null ? "unreachable" : `+${Math.round(d)} s`}  ${h.place.name ?? `(${kind})`}  ${h.place.lat.toFixed(5)},${h.place.lon.toFixed(5)}`,
  );
}
const geojson = take("--geojson");
if (geojson) {
  writeFileSync(
    geojson,
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r.plan.coordinates.map((c) => [c.lon, c.lat]) } },
        ...found.hits.map((h) => ({ type: "Feature", properties: { name: h.place.name, detourS: detours.get(h.place.key) }, geometry: { type: "Point", coordinates: [h.place.lon, h.place.lat] } })),
      ],
    }),
  );
}
