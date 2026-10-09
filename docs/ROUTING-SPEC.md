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

- **R1 done:** this spec; SPEC.md moved routing here from Valhalla.
- **R2 done:** the planner `src/nav/routing/` (§4–5) and `npm run route` (§7): city routes in 0.1 s or less, oblast
  routes up to 1 s, in Node.
- **R3 done:** turn instructions (§6).
- **R4 built and driven (2026-10-05, routes in 6 trip logs, both adapters):** guidance (`src/nav/routing/guidance.ts`), the route service
  (`src/services/navigation/route-service.ts`), trip-log records, and the app: long press → Route here, the city list,
  the banner and the route on the map, spoken maneuvers (§8, UI-SPEC §6.3, §7.1). Checked on simulated drives
  (§8.4); routes and guidance show in `replay:view`.
- **R5 built, off:** the route as a hint for map matching, a developer switch; measured in §8.6.
- Next: read §8.3's questions from the 2026-10-05 logs (`nav_route`, `route …` notes), then the ETA speeds from
  them.

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Engine | **A\* in pure TS** (`src/nav/routing/`) over the region's `<region>.graph.bin`, read by its own `TiledRoadGraph` (own tile cache, so planning never evicts the filter's working set). Valhalla and its routing tiles are dropped: its native packaging was never solved (SPEC §9.8), its tiles would be a second download per region, and its roads would differ from the filter's. |
| Search state | **Directed edges** (edge, direction), not nodes, so turn costs and `from → via node → to` restrictions are exact. |
| Cost | **Time** (s): length at a speed per road class, plus junction and turn costs and penalties for private, minor service and track roads (§4). No traffic, no time of day. |
| OSM rules | **Hard** for planning: never against a one-way, never a restricted turn, U-turns only at dead ends or at the start. (The filter keeps them soft, MAPMATCH-SPEC §3: a route must be legal, a position must survive wrong tags.) |
| Extent | One region, as for map matching: no cross-region routes. |
| Destination | A point on the map (long press), a city from the list, or an address search result ([SEARCH-SPEC.md](SEARCH-SPEC.md)). |
| Instructions | From the route's geometry and the graph (turn angle, roundabouts); **no street names in v1** (not in the graph, MAPMATCH-SPEC §15.4). The map shows names. |
| Thread | The JS thread, in slices (§5.4): a long search must not freeze the map. |

## 4. Cost model (starting values; tune from drives)

Time to drive an edge = OSM length ÷ speed. Speeds (km/h) by class (MAPMATCH-SPEC §4.3):

| motorway | trunk | primary | secondary | tertiary | unclassified | residential | living_street | service | track | road |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 110 | 90 | 60 | 50 | 45 | 35 | 25 | 8 | 12 | 10 | 20 |

- Minor roads first were 40 / 30 / 10 / 20 / 15 / 25 km/h with turns 5 / 10 / 10 / 15 s. On 2026-10-05 a test route across town
  in Chernihiv went 316 m along a service lane through the blocks and 215 m of residential street (1.47 km), where
  the driver takes the main street (tertiary, 1.84 km, 123 m residential). Now near OSRM's car profile (residential
  25, service 15) with turns 8 / 15 / 15 / 20 s, which picks the main street. 40 random routes within 8 km of the
  city: no failures, 16 / 32 ms p90. Still to calibrate: the logs have each plan's time and the time driven.

- Links (`link` flag): 0.6 × the class speed. Roundabouts: at most 30 km/h.
- **Junction** (a node with 3 or more edges): 2 s for passing it, plus the turn by the angle between arrival and
  departure (clockwise positive): straight (< 30°) 0 s; right 8 s; left 15 s (crossing oncoming traffic); sharp
  (> 120°) right 15 s, left 20 s. A node with 2 edges is a bend in one road: no cost.
- **U-turn**: 30 s, only at a dead end (no other legal exit). Starting against the car's heading counts as a U-turn
  on the road: 60 s; 300 s while the car drives (over 3 m/s: a re-plan after a wrong turn), as turning mid-street
  needs a gap and is often not allowed. On 2026-10-06 a re-plan at 40 km/h said "turn around" (131 s + 60 s) where
  going round the block was 243 s: the route the driver then took.
- **Entry penalties** (on entering the edge, not for the start or destination edge): private access 600 s, minor
  service (driveway, parking aisle) 60 s, track 120 s.
- Forbidden: against a one-way, a restricted turn (`no_*`, or not the `only_*` exit).

ETA is this time. It will read short in a city with traffic lights; calibrate the speeds and junction cost from
drives (trip logs give the real time per edge class).

## 5. Planner (`src/nav/routing/`)

### 5.1 Start and destination

- **Start**: the car's position and, when known, heading (the puck: map-matched while dead-reckoning). Candidate
  edges: the nearest, plus any within `max(25 m, accuracy)` and within 10 m of the nearest (a parallel road), but
  not those that only meet the nearest at its end node (a junction just ahead or behind). Each allowed direction is
  a start state costing the rest of the edge from the projected point. With the heading known, the direction more
  than 90° off it costs the turnaround (60 s, 300 s while driving: §4).
- **Destination**: the nearest edge to the point within 500 m, preferring a public road (not private, not minor
  service) when one is within 50 m of the nearest. Reached in either allowed direction, at the projected point.
- Start and destination on the same edge with the destination ahead: the route is that stretch.
- **Road islands.** OSM has car parks, yards and track networks connected to nothing (by footways, or not at all).
  So every other edge within 500 m of either end is a fallback end, costing 3600 s plus 1 s per metre off (twice
  that at the start: better to end away from the pin than to start away from the car). They only win when the
  main end can't be reached; the plan reports how far its ends are from the points (`offRoadM`), and its duration
  leaves the penalties out. Before searching, each end's roads are followed regardless of direction up to 3000
  edges: if that runs out without meeting the other end's roads, there is no route, found in ~10 ms instead of a
  search through the whole region.

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

## 6. Instructions (R3, `src/nav/routing/maneuvers.ts`)

`routeManeuvers(graph, plan)` gives `depart`, then one maneuver per junction where the driver has to choose, then
`arrive`, each with its distance from the start, position and turn angle:

- **Choices.** At the end of each leg, the other legal ways on (not U-turns, one-ways against, restricted turns).
  From a main road, driveways, service roads, tracks, private roads and slip roads don't count: staying on the road
  past them needs no instruction. No other way: no instruction, however much the road bends.
- **Straight on.** The straightest way, turning less than 45°, needs none, unless another way of similar
  importance (road class at most one step lower) is within 35° of it: then `keep-left` / `keep-right`.
- **Turns** otherwise, by angle: `slight-*` under 45°, `left` / `right` up to 135°, `sharp-*` beyond; `u-turn`
  back along the same road (a dead end).
- **Roundabouts:** one `roundabout` maneuver at the entry, with the exit to take: the legal ways off it passed on
  the way, plus one.
- **Turning around at the start:** when the route leaves against the car's heading (`plan.startTurnaround`), a
  `u-turn` at 0 m comes first.

Checked by eye on Chernihiv and Kyiv routes (`npm run route` prints them): 5 instructions on 4.2 km across
Chernihiv, 12 on 13 km across Kyiv, 12 on 172 km across the oblast.

## 7. Measurements (`npm run route`)

`npm run route -- --from lat,lon --to lat,lon [--graph <file>] [--geojson <out>]` prints the route; `--bench <n>
[--at lat,lon --radius km]` plans `n` random routes between road points (in the region, or within the radius) and
prints planning time and states by straight-line distance. Targets on the iPhone: a city route (≤ 15 km) under
0.5 s, an oblast route under 3 s. The router's own graph keeps 2048 decoded tiles (~20 MB held).

Node on the Windows PC, cold tile cache (2026-10-05):

| Graph, routes | Straight line | ms p50 / p90 / max | States p50 / max | Route ÷ line |
| --- | --- | --- | --- | --- |
| Chernihiv, within 8 km of the centre | 0–5 km | 19 / 44 / 79 | 3 323 / 29 721 | 1.73 |
| | 5–15 km | 47 / 106 / 112 | 17 265 / 47 319 | 1.45 |
| Kyiv city, within 15 km of the centre | 0–5 km | 11 / 29 / 29 | 6 220 / 12 978 | 1.75 |
| | 5–15 km | 95 / 360 / 602 | 41 027 / 211 749 | 1.46 |
| | 15–50 km | 352 / 535 / 622 | 121 822 / 211 041 | 1.45 |
| Chernihiv oblast | 15–50 km | 28 / 181 / 181 | 6 343 / 34 211 | 1.30 |
| | 50–100 km | 304 / 461 / 619 | 56 955 / 164 864 | 1.44 |
| | 100+ km | 530 / 949 / 964 | 141 499 / 241 588 | 1.37 |

- A 172 km route across the oblast (Chernihiv → Pryluky area) settles 148 k states; it reads 81 k tiles with the
  filter's 128-tile cache (1.1 s), 5.2 k with 2048 (0.57 s, 20 MB held), 4.5 k with 4096 (0.51 s, 79 MB).
- Of 130 random routes, 4 had no road route: 3 ended on track networks or yards connected to nothing, now refused
  in ~10 ms (island check); one start on a source-only stretch found its route once fallbacks were added.
- **Speed-up (2026-10-06, `npm run route:bench`).** The phone hit `too-far` on long routes: with the straight-line
  heuristic at the fastest speed (110 km/h) an exact search floods the country (Slavutych → Lviv-like routes on the
  synthetic grid: over 1 M states). Now:
  - **Hierarchy pruning** (`HIERARCHY` in router.ts): from 12 km off the nearer end only roads up to tertiary are
    searched, from 35 km up to secondary, from 80 km up to primary. A node whose legal exits are all smaller roads
    keeps them; a pruned search that finds no route searches again with every road.
  - **Weighted heuristic** (`HEURISTIC_WEIGHT` 1.5): routes at most 1.5× the fastest in theory, within 0.25 % of it
    on the benchmark. Weight 2 settles 10× fewer states again but routes came out up to 3.8 % slower.
  - **Per state**: states in typed arrays behind one map lookup, a typed-array heap, memoised headings, `exits`
    skips restriction work where there is none, the tile cache stamps its last use instead of reordering a map on
    every lookup (and evicts an eighth at a time), edge decoding projects without allocating. ~2.5 µs per state in
    Node, from ~8–12.
  - **Slices of 32 ms** instead of 12 (route-service.ts): every yield waits about a frame for the next timer tick.

  Synthetic 600 × 300 km grid (Ukraine-like hierarchy), 240–470 km routes: 350 k → 50 k states, 13.0 s → 1.3 s
  cold for 4 routes (warm 0.56 s), routes within 0.2 % of the exact search's time. Default 250 × 150 km grid,
  107–198 km: 24 s → 1.9 s for 6 routes. `--exact` prints each route against the exact search, `--options '<json>'`
  passes `RouteOptions` (`hierarchy`, `heuristicWeight`), `--graph <file> --at lat,lon --radius km` uses a real graph.
- On the phone: unknown. The filter's updates ran about as fast on the iPhone as in Node (MAPMATCH-SPEC §15.9), but
  tile reads go through the file system there. The app logs every plan's time (§8); if oblast routes are slow,
  the candidates are a routing-only tile decode (no geometry arrays) and skipping minor roads far from both ends.
- ETA: the model's 50 min for 32 km across Kyiv and 162 min for 172 km are guesses until calibrated (§4).

## 8. App and the route hint (R4, R5)

### 8.1 Guidance (`src/nav/routing/guidance.ts`)

`RouteGuidance` takes each published position (the puck: map-matched while dead-reckoning) and gives the state, the
distance driven along the route, the distance off it, what's left (metres, and the plan's time scaled by it), the
next maneuver and the distance to it, and the one after when it follows within 120 m.

- **Matching:** the closest point of the route's polyline between 100 m behind the last progress and 300 m ahead,
  plus 3 s at the current speed, plus 1.5 × the distance driven since the position last matched (after a detour the
  car rejoins further on); moving faster than 3 m/s, only stretches within 75° of the heading. Never the whole route:
  a route that passes the same street twice would make progress jump to the later pass.
- **Off the route** beyond max(40 m, 1.5 × the position's accuracy): `leaving` at once, `off` after 4 s and 30 m
  driven (from the speed, so a parked car or a jumping position never counts as leaving). `unsure` instead while
  map matching is `multimodal` or `init`, or the position is phone GPS that isn't trusted (spoofing can put it
  anywhere): neither on nor off is decided then, and the count towards `off` pauses (it used to restart: while
  dead-reckoning map matching turns multimodal every 10–15 s, and on 2026-10-06 the car drove 700 m off a route
  without `off`). Driving the route the wrong way is off it. Until the car has been on the route once (it may
  start in a car park or a yard), `off` takes 200 m of driving instead of 30 m; a re-plan starts where the car
  drives, so it is on its route from the start.
- **Arrived** within 30 m of the route's end along it, or of its last point once less than 300 m is left (a route
  may pass near its end earlier), and it stays arrived.
- A maneuver passed by less than 10 m is still the next one (the puck lags the turn).
- **Progress point**: the last polyline vertex passed and the point on the route; the map draws the route from
  there on (UI-SPEC §6.3).

### 8.2 Route service (`src/services/navigation/route-service.ts`, `runtime.routes`)

- `start(destination)` plans from the published position (with its heading and accuracy) on its own reader of the
  active region's graph (2048 tiles), framed at the start. The search runs in slices of ~12 ms (the slice size
  adapts to the phone's speed), yielding to the UI in between.
- `off` (and not planning, and the wait below elapsed) plans again from where the car is; the old route stays
  drawn, faded. A failed re-plan keeps the old route and retries at the next `off` after the cooldown. A failed
  first plan ends in `failed` with the reason.
- **Not while map matching is `offroad`**: the filter itself says the dot is on no road, so `off` means "the car is
  lost", not "the car turned", and a plan from a dot beside the road starts off it and goes off again at once.
- **The wait** starts at 10 s and doubles for each off-route plan whose route goes `off` again within a minute of
  being made, up to 160 s; a route that stays on for a minute clears the streak. A plan that did not survive its
  own first seconds did not fix anything: the route was never the problem, the position was. The minute is measured
  from the plan to its route going off, never from one plan to the next: the waits from 80 s on would otherwise
  end the streak themselves, and it would cycle 10 → 80 s without reaching the cap.
  > Both rules come from 2026-10-06, 2 h 11 min of jamming: a flat 10 s cooldown re-planned a 62 km route 25 times
  > in 12 min at 700–780 ms a plan, 86 off-route plans over six trips, every one from a dot kilometres from the
  > car. 16 km into one drive, a 95° turn the route itself asked for landed 62 m short of the junction, the filter
  > went off-road, and 4 plans went out in 31 s while it found the road again on its own (MAPMATCH-SPEC
  > §15, item 14).
- Arrival ends the route a minute later; × ends it at once.
- The active destination is kept (kv-store `route.active`): an app restarted within 12 h (iOS may end it mid-drive)
  plans it again from the first position, noted `route resumed after an app restart, to …`.
- **Trip log** (TRIP-LOGGER-SPEC §6.3): every plan (`nav_route`, with its polyline `nav_route_point` and maneuvers
  `nav_route_maneuver`), guidance at every published position (`nav_route_progress`), and notes: `route to …`,
  `route plan #n (reason): length, minutes, maneuvers; states, tiles, ms in slices (wall ms)`, `route plan #n
  failed: …`, `route off|on|unsure at <km>, <m> off, ±<accuracy>, <source>/<map match>`, `route arrived …:
  <min> (planned <min>), driven <km> (planned <km>)`, `route stop at <km> of <km>`. A route planned before the trip
  starts is logged again when it does (reason `resume`), on the recorder's `tripStarted`, once the log is open: the
  "recording" state comes before it, and a route written then was lost (every such trip until 2026-10-09, n9ytqu).
  Replays of those logs plan it again (`routeBeforeLog`, tools/replay/app-chain.ts): from where the drive starts to
  the destination of the log's first plan, shown in the viewer as "rebuilt".

### 8.3 What the first drives should answer (all from the trip log)

1. **Planning time on the iPhone**: `plan_ms`, `wall_ms` and `slices` per plan, against Node's (§7) for the same
   route (`npm run route -- --from … --to …` replans it on the PC).
2. **ETA**: `route arrived` notes, planned minutes against real ones, and length against distance driven. Then the
   speeds per road class and the junction cost (§4) can be fitted to the drives.
3. **False "off route"**: `route off` notes while the car was on the route (GPS truth in the log), especially
   while dead-reckoning; and late ones: the distance driven off the route before `off`.
4. **Instruction timing**: `to_next_m` when the car actually turned (from the GPS track): is the next maneuver
   still the right one through the turn, and does the puck's lag show?
5. **Re-plans**: how often, where from (`nav_route` with reason `off-route`), and whether the new route started on
   the road the car was on.

### 8.4 Simulated (`npm run route:sim`, 2026-10-05)

City drives from the simulator (MAPMATCH-SPEC §9.4), 60 min × seeds 1–3, GPS for the first 3 min, then none; the
replay's puck (`replayPuck`, what NavigatorService publishes) fed to guidance as the app does.

- **Following the route** (routes along the car's own path, cut where it loops back: every "off" is false):
  Chernihiv 30 routes / 2.7 h and Kyiv 26 / 2.7 h: **no false "off"**; `unsure` 0.2 % of the time; progress along
  the route off by 5 / 4 m median, 13 / 10 m p90, 90 / 123 m at most.
- **Leaving the route** (a route planned every 6 min to a point 2–4 km away; the car keeps to its own way): all 28
  departures noticed, 5–6 s and ~50 m (median) after the car was 25 m off the route; at most 59 s / 173 m (slow
  traffic); no "off" before the car left. With GPS all along, the same. (2026-10-06, Chernihiv: the count restarting
  at each `unsure` had made it 8 s / 67 m median, 129 s / 925 m at most; pausing it instead, 5 s / 45 m and
  59 s / 173 m.)
- Two fixes came from it: an early `arrived` where a route passed near its end, and progress jumping to a later
  pass over the same street (the whole-route search, now gone). It is optimistic as the simulator is (§9.4 there):
  no parking, reversing or unmapped roads.

### 8.5 Voice (`src/nav/routing/announcer.ts`, `src/components/route/voice-*.ts`, `tools/voice/`)

Recorded phrases from a neural voice (Ukrainian `uk-UA-PolinaNeural`, English `en-GB-SoniaNeural`), whole phrases,
distance included and in words ("Через триста метрів, поверніть ліворуч"; digits get misread, "50" as "50th"), so
the intonation and the grammar of numbers ("один кілометр", "півтора кілометра", "два кілометри") are right. `npm run voice:render` records them into `assets/voice/<lang>/` (edge-tts, silence trimmed)
and writes the clip index; a Jest test fails when the words changed without recording again. Each clip (mono) is
compressed, so quiet syllables carry over music and road noise, and brought to −15 LUFS, peaks under −1.5 dBFS: the loudest
the voice plays, for loud music. The default volume plays it near −19 LUFS (below), Google's reference for mono voice,
as loud as its assistant's speech (−16 LUFS stereo); −15 itself was too loud in the car. Played with `expo-audio` one after another, lowering other audio
meanwhile (the music stays down through an announcement: expo-audio releases the session 100 ms after a clip only when
nothing plays by then), also with the ring/silent switch on and with the app in the
background (`shouldPlayInBackground`, the `expo-audio` plugin's background playback; without it expo-audio pauses its
players when the app leaves the screen). The voice goes wherever the phone's audio goes: to a car's Bluetooth while it
is connected, silent when the car plays another source (CarPlay of another phone), and the app can't tell. When that
output goes away (Bluetooth turned off) expo-audio pauses its players and never resumes them: a clip paused that way
is played again from its start (twice at most), on the phone's speaker. Without turning Bluetooth off, holding the
banner's voice button opens the system's output picker, and the button shows where the voice goes (`modules/audio-output`;
UI-SPEC §6.3). iOS: Apple's picker, opened by a tap sent to its button (it has no call to open it). Android: the output
switcher (14+), the System UI media output dialog (12–13), the Settings panel (11), else Bluetooth settings; where the
media plays is `getAudioDevicesForAttributes` (13+), else the connected output media prefers. Android doesn't pause
the voice when its Bluetooth goes away (expo-audio leaves ExoPlayer's "becoming noisy" off). An announcement without a
clip for every phrase (a roundabout exit past the 6th) is said by the system voice (`expo-speech`, `uk-UA` /
`en-US`), which is silent while the ring/silent switch is on.

Each maneuver is said twice. Ahead of it, at a spoken distance: 50, 100, 200, 300, 400, 500, 600, 800 m, 1, 1.5 or
2 km, the first at or beyond max(250 m, 15 s at the current speed), so the distance said is the distance left (a
maneuver already closer, after a start or re-plan: the nearest). At it, at max(40 m, 4 s): "Поверніть ліворуч", with
"потім …" when the next follows within 120 m ("і ви на місці" for the destination). "Ahead" is skipped when "at it"
would follow within 6 s. Roundabout exits are ordinals ("другий з’їзд"). Also "Маршрут перебудовано" for a re-plan
and "Ви прибули". Nothing about the current plan's maneuvers while off it. The banner's speaker button mutes it (kept
across launches). Settings has the voice's volume, 0–100 % (kept across launches; a sample is said when the slider
rests; 0 turns the voice off and hides the banner's speaker button). The player's gain is its square, so equal steps
sound about equal: 100 % plays the clips as recorded, the default 80 % 3.9 dB lower (near −19 LUFS), 50 % 12 dB lower. It is
the player's volume, applied to the clips and the system voice: the clips aren't recorded again to change it.

Into the trip log: `audio output: <kind> "<device>"` when a route starts and `audio output now: … (<why>)` on each
change (speaker, receiver, wired, bluetooth, carplay, airplay), `voice say <phrase ids>` for each announcement (`(system voice)` without clips, `after <n>
waiting` when queued), `voice muted: …` for one not said, and what went wrong: a clip that never reported its end
(given up after 8 s), one that didn't load or play (said by the system voice instead), the system voice failing or
never finishing (given up after 4 s + 0.12 s a character), a clip paused by the system and played again. Whatever
the player does, the next announcement is said.

### 8.6 Route hint (R5, built, off)

`Navigator.setRouteHint(edges)` (`NavConfig.routeHintFactor`, 3): at a junction the particle filter sends that many
times more particles onto an exit along the route. Only the proposal at junctions changes, never the weights, so
the turns still decide (a test drives a 10:1 hint the wrong way and the filter follows the car). In the app it is a
developer switch, **off by default** ("Tell map matching the route"; trip-log info `nav_route_hint`, note
`nav route hint …`). `npm run route:sim -- --hint <factor>`, same drives as §8.4 (Chernihiv / Kyiv):

| Hint | Dot off the truth p50 / p90 / max | Progress error max | Top hypothesis on the car's edge | Departures: median, worst | False "off" before leaving |
| --- | --- | --- | --- | --- | --- |
| off | 5 / 9 / 48 m; 4 / 8 / 33 m | 90 m; 123 m | 81.3 %; 82.0 % | 5 s / 51 m, 59 s / 173 m; 6 s / 50 m, 43 s / 177 m | 0; 0 |
| 3× | 4 / 9 / 43 m; 4 / 8 / 31 m | 46 m; 20 m | 80.9 %; 82.1 % | 5 s / 53 m, 59 s / 173 m; 6 s / 52 m, 43 s / 177 m | 0; 0 |
| 10× | 4 / 9 / 55 m; 4 / 9 / 28 m | 46 m; 18 m | 83.8 %; 82.6 % | 9 s / 71 m, 117 s / 925 m; 6 s / 62 m, 10 s / 105 m | 1; 0 |

- 3× changes little: the simulated filter already holds the road (dot median 4–5 m), so a prior adds almost nothing
  but trims the worst progress errors. 10× starts to hide real departures (925 m before Chernihiv's slowest was
  noticed). Hence off, 3× when on.
- Worth trying on the road only where map matching struggles without it (multimodal for long stretches, MAPMATCH-SPEC
  §9.4's long arterials); the simulator is optimistic there.

## 9. Milestones

| # | Output |
| --- | --- |
| R1 | This spec; SPEC.md moves routing from Valhalla to here |
| R2 | Planner (§4–5), `npm run route` with timings on Chernihiv and Kyiv |
| R3 | Turn instructions (§6) |
| R4 | App: destination, route line, banner, re-plan |
| R5 | The route as a map-matching hint, measured in the simulator (built, off: §8.6) |

## 10. Open items

1. Street names in instructions: add a name table to the graph (format change, MAPMATCH-SPEC §4.5).
2. **Address search** — built: [SEARCH-SPEC.md](SEARCH-SPEC.md). Background: the map tiles (Planetiler, OpenMapTiles layers) hold places, named POIs, street names
   (`transportation_name`) and house numbers (`housenumber`), but a house number there has no street: it would be
   guessed from the nearest named road, which fails at corners and for buildings set back inside a block. And
   searching them means decoding every z14 tile of the region, so it would need an index built on the phone after
   the download anyway. Preferred: a small search index built with the region in `tools/tiles` from the OSM extract
   (`addr:street` + `addr:housenumber`, places, POIs), downloaded with the map.
3. ETA calibration from drives (§4).
