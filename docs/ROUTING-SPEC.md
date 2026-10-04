# wtf.ai — Routing Specification

Status: draft v1 (2026-10-05). Implements the routing part of SPEC.md Phase 6. Replaces Valhalla (SPEC §2) with
A* on the map-matching road graph ([MAPMATCH-SPEC.md](MAPMATCH-SPEC.md) §4–5). Source of truth for coding agents.

## 1. Goal

Plan a drive to a destination offline and guide the driver along it, so that:

1. Routes are planned on the phone from the region already downloaded: no extra files, no native code.
2. Guidance keeps working without GPS: progress along the route and leaving it are judged from the map-matched
   position (MAPMATCH-SPEC §6.2), not from raw fixes.
3. The route and the position filter see the same roads: same one-ways, same turn restrictions, same edge ids.
4. Later, the route helps map matching: at a junction the driver more likely takes the route's exit (§8).

## 2. Status (2026-10-05)

- **R1 (this spec) and R2 (the planner, §4–5)** in progress.
- The app's `route` screen is still the UI-first mock (UI-SPEC §7.1): a list of cities and a straight line.

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Engine | **A\* in pure TS** (`src/nav/routing/`) over the region's `<region>.graph.bin`, read by its own `TiledRoadGraph` (own tile cache, so planning never evicts the filter's working set). Valhalla and its routing tiles are dropped: its native packaging was never solved (SPEC §9.8), its tiles would be a second download per region, and its roads would differ from the filter's. |
| Search state | **Directed edges** (edge, direction), not nodes, so turn costs and `from → via node → to` restrictions are exact. |
| Cost | **Time** (s): length at a speed per road class, plus junction and turn costs and penalties for private, minor service and track roads (§4). No traffic, no time of day. |
| OSM rules | **Hard** for planning: never against a one-way, never a restricted turn, U-turns only at dead ends or at the start. (The filter keeps them soft, MAPMATCH-SPEC §3: a route must be legal, a position must survive wrong tags.) |
| Extent | One region, as for map matching: no cross-region routes. |
| Destination | A point on the map (long press), or a city from the list. Search by address comes later (§10.2). |
| Instructions | From the route's geometry and the graph (turn angle, roundabouts); **no street names in v1** (not in the graph, MAPMATCH-SPEC §15.4). The map shows names. |
| Thread | The JS thread, in slices (§5.4): a long search must not freeze the map. |

## 4. Cost model (starting values; tune from drives)

Time to drive an edge = OSM length ÷ speed. Speeds (km/h) by class (MAPMATCH-SPEC §4.3):

| motorway | trunk | primary | secondary | tertiary | unclassified | residential | living_street | service | track | road |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 110 | 90 | 60 | 50 | 45 | 40 | 30 | 10 | 20 | 15 | 25 |

- Links (`link` flag): 0.6 × the class speed. Roundabouts: at most 30 km/h.
- **Junction** (a node with 3 or more edges): 2 s for passing it, plus the turn by the angle between arrival and
  departure (clockwise positive): straight (< 30°) 0 s; right 5 s; left 10 s (crossing oncoming traffic); sharp
  (> 120°) right 10 s, left 15 s. A node with 2 edges is a bend in one road: no cost.
- **U-turn**: 30 s, only at a dead end (no other legal exit). Starting against the car's heading counts as a U-turn
  on the road: 60 s.
- **Entry penalties** (on entering the edge, not for the start or destination edge): private access 600 s, minor
  service (driveway, parking aisle) 60 s, track 120 s.
- Forbidden: against a one-way, a restricted turn (`no_*`, or not the `only_*` exit).

ETA is this time. It will read short in a city with traffic lights; calibrate the speeds and junction cost from
drives (trip logs give the real time per edge class).

## 5. Planner (`src/nav/routing/`)

### 5.1 Start and destination

- **Start**: the car's position and, when known, heading (the puck: map-matched while dead-reckoning). Candidate
  edges within `max(25 m, accuracy)` of it, nearest first, plus any within 10 m of the nearest. Each allowed
  direction is a start state costing the rest of the edge from the projected point. With the heading known, the
  direction more than 90° off it costs the 60 s turnaround.
- **Destination**: the nearest edge to the point within 500 m, preferring a public road (not private, not minor
  service) when one is within 50 m of the nearest. Reached in either allowed direction, at the projected point.
- Start and destination on the same edge with the destination ahead: the route is that stretch.

### 5.2 Search

- A\* over directed edges. `g` is the time to the end of the directed edge; expanding it takes the exits at its end
  node (`RoadGraph.exits`), drops the forbidden ones and adds junction, turn, entry and edge time.
- A state whose next edge is the destination edge in an allowed direction also offers the goal, at the time to the
  destination point. The search ends when the goal is the cheapest open entry.
- Heuristic: straight-line distance to the destination ÷ 110 km/h (the fastest speed), so the result is optimal.
  If long routes prove too slow (§7), a weighted heuristic or skipping minor roads far from both ends are the
  candidates; decide from measurements.
- Limit: `maxStates` settled states (failure: "too far for the phone").

### 5.3 Output

- `legs`: directed edges in order, `fromM`/`toM` along each edge's geometry (first and last partial).
- `lengthM`, `durationS`, `coordinates` (lat/lon polyline), and search stats (states settled, tiles read, ms).
- Edge ids are those of the region's graph file, shared with the filter (both read the same file).

### 5.4 Slicing

`RouteSearch.run(maxStates)` advances by at most that many states and returns `done` or `more`; the app runs it in
slices between frames and shows progress. `planRoute()` runs it to the end (tools, tests).

## 6. Instructions (R3)

From the legs: one maneuver per junction where the route does not simply continue (turn ≥ 30°, or a fork where
another exit is within 30° of the route's), plus roundabouts ("take the 2nd exit") and arrival. Each with its
distance from the start. Details in R3.

## 7. Measurements (`npm run route`)

`npm run route -- --from lat,lon --to lat,lon [--graph <file>]` prints the route; `--bench <n>` plans `n` random
routes in the region and prints planning time and states by distance. Targets on the iPhone (to confirm from Node
first): a city route (≤ 15 km) under 0.5 s, an oblast route under 3 s.

## 8. App and the route hint (R4, R5)

- **R4 App**: long press to set the destination, the route drawn on the map, the next-turn banner with distance,
  progress along the route from the puck. Off the route: the map-matched position more than 40 m from it for 5 s,
  or the filter tracking on an edge not on the route; then plan again from the puck. While the filter is
  multimodal, wait.
- **R5 Route hint**: at a junction the filter weights the route's exit higher (soft, e.g. 3×), measured in the
  simulator (MAPMATCH-SPEC §9.4) with drivers who follow the route and drivers who leave it.

## 9. Milestones

| # | Output |
| --- | --- |
| R1 | This spec; SPEC.md moves routing from Valhalla to here |
| R2 | Planner (§4–5), `npm run route` with timings on Chernihiv and Kyiv |
| R3 | Turn instructions (§6) |
| R4 | App: destination, route line, banner, re-plan |
| R5 | The route as a map-matching hint, measured in the simulator |

## 10. Open items

1. Street names in instructions: add a name table to the graph (format change, MAPMATCH-SPEC §4.5).
2. **Address search.** The map tiles (Planetiler, OpenMapTiles layers) hold places, named POIs, street names
   (`transportation_name`) and house numbers (`housenumber`), but a house number there has no street: it would be
   guessed from the nearest named road, which fails at corners and for buildings set back inside a block. And
   searching them means decoding every z14 tile of the region, so it would need an index built on the phone after
   the download anyway. Preferred: a small search index built with the region in `tools/tiles` from the OSM extract
   (`addr:street` + `addr:housenumber`, places, POIs), downloaded with the map.
3. ETA calibration from drives (§4).
