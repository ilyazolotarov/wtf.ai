# wtf.ai — Routing Specification

Route planning, guidance, voice and alternatives (`src/nav/routing/`, `src/services/navigation/route-service.ts`)
on the map-matching road graph ([MAPMATCH-SPEC.md](MAPMATCH-SPEC.md) §4–5). Source of truth for coding agents.

## 1. Goal

1. Routes are planned on the phone from the region already downloaded: no extra files, no native code.
2. Guidance keeps working without GPS: progress along the route and leaving it are judged from the map-matched
   position, not from raw fixes.
3. The route and the position filter see the same roads: same one-ways, same turn restrictions, same edge ids.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Engine | **A\* in pure TS** over the region's `<region>.graph.bin`, read by its own `TiledRoadGraph` (own tile cache of 2048 tiles, so planning never evicts the filter's working set). |
| Search state | **Directed edges** (edge, direction), not nodes, so turn costs and `from → via node → to` restrictions are exact. |
| Cost | **Time** (s): length at a speed from the map's limit, setting and surface (by class on graphs without attributes), plus junction, turn and traffic-light time, rush hours in big cities, penalties for private, minor service and track roads (§4). No live traffic: none is open for Ukraine (TomTom answers nothing for Ukrainian points, Google switched public traffic off, the open collections list no Ukrainian speeds). |
| OSM rules | **Hard** for planning: never against a one-way, never a restricted turn, U-turns only at dead ends or at the start. (The filter keeps them soft: a route must be legal, a position must survive wrong tags.) |
| Extent | One region: no cross-region routes. |
| Destination | A point on the map (long press), a city from the list, or an address search result ([SEARCH-SPEC.md](SEARCH-SPEC.md)). |
| Instructions | From the route's geometry and the graph (turn angle, roundabouts); no street names (not in the graph). |
| Thread | The JS thread, in slices (§5.4): a long search must not freeze the map. |

## 3. Status

Built and driven: planner, instructions, guidance, re-planning, voice, alternatives, route times from the map.
Open items: §10.

## 4. Cost model (`src/nav/routing/cost.ts`, `DEFAULT_ROUTE_COSTS`)

Time to drive an edge = OSM length ÷ its speed, plus junction, turn and traffic-light time. Speeds come from the
map's speed attributes (§4.1) on graphs that have them (`EdgeFlag.attributes`); on older graphs from the class alone
(km/h):

| motorway | trunk | primary | secondary | tertiary | unclassified | residential | living_street | service | track | road |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 110 | 90 | 60 | 50 | 45 | 35 | 25 | 8 | 12 | 10 | 20 |

Minor roads are near OSRM's car profile: slower values sent a test route through a residential block's service
lanes instead of the main street.

- Links (`link` flag): 0.6 × the speed. Roundabouts: at most 30 km/h.
- **Junction** (a node with 3 or more edges): 2 s, plus the turn by the angle between arrival and departure
  (clockwise positive): straight (< 30°) 0 s; right 8 s; left 15 s (crossing oncoming traffic); sharp (> 120°)
  right 15 s, left 20 s. A node with 2 edges is a bend: no cost. **Straight on along the priority road** (arriving
  and leaving on a bigger class than every other road there) costs no junction time: a village's side lanes every
  100 m would add ~20 s/km nobody loses.
- **U-turn**: 30 s, only at a dead end. Starting against the car's heading is a turnaround: 60 s parked, 300 s while
  the car drives (over 3 m/s: turning mid-street needs a gap and is often not allowed, so going round the block wins
  unless much longer). "Against" while driving is more than 90° off the heading; parked, more than 120° (a car
  standing across the road leaves either way at the same cost). A parked heading less sure than ±30° is no heading;
  while driving the heading counts however rough.
- **Entry penalties** (on entering the edge, not the start or destination edge): private access 600 s, minor
  service (driveway, parking aisle) 60 s, track 120 s.
- Forbidden: against a one-way, a restricted turn (`no_*`, or not the `only_*` exit).

ETA is this time (`plan.durationS`).

### 4.1 Speed from the map

`edgeSpeedMps`: the limit × a share for where the road is, capped by class and surface.

- **Limit:** the tagged one, else by law: 50 in a settlement (`urban`), 90 outside, 130 on motorways.
- **Share** of the limit driven between junctions, free-flowing: outside settlements 1.1; in a town or village 1.3 on
  its through roads (motorway, trunk, primary, secondary) and 1.0 on its other streets; in a city 0.9, its traffic
  lights priced apart; in a big city (`bigCity`) 1.15 on its trunk, primary and secondary roads, at most 70 km/h.
  From the logged drives: ~102 km/h on rural roads limited to 90, 75 on 50 through villages, 39 on untagged town
  tertiaries, 24–29 on a regional city's primaries; in Kyiv 58 on trunks and 55 on primaries limited to 50, lights
  included, where 0.9 planned 42 (one 42 km drive across Kyiv: planned 16 % too long, within 2 % at 1.15). Kyiv's
  smaller streets drove as 0.9 plans them. More Kyiv drives should confirm or move the 1.15.
- **Caps** (km/h): motorway 120, trunk 110, primary 100, secondary 90, tertiary 80, unclassified 60, residential 30,
  living_street 10, service 15, track 15, road 30. Unpaved: at most 30.
- The A* heuristic's speed is the fastest in either table (120 km/h; 110 on graphs without attributes).

### 4.2 Junction controls

A junction with traffic lights (`NodeFlag.signals`): +15 s, the mean wait for green and the start. A light away from
junctions (`EdgeFlag.signals`, a signalled crossing): +5 s, charged by the share of the edge driven. Stop and
give-way signs are in the graph but cost nothing: they hold only the minor road, and which approach that is isn't
known when passing the node.

Measured against the testers' drives (time lost from 150 m before a junction to 40 m after it, by the wheels, against
the speed driven nearby; nodes within 60 m one crossing; 10 % trimmed each side): straight through lights 15 s
(planned 17), left at lights 41 s (41), right at lights 17 s (27), out of a side road onto a main road without
lights 16–22 s (14–18). The untrimmed means are far higher (parking, stops to let someone out), and charging them
(+15 s for left at lights, +15 / +25 s out of a side road) made the planned times worse over all the drives: 15 %
too long instead of 9 %, windows scattered 29 % instead of 26 %.

### 4.3 Rush hours (`congestion.ts`)

`RouteCosts.congestion` multiplies the time on the main roads (trunk to tertiary) of big cities (`bigCity`, ≥ 500 000
people). The route service sets it from the phone's clock when a plan starts (note `route plan #n …; rush hour ×f`).

| Mon–Fri | 07–08 | 08–09 | 09–10 | 17–19 | 19–20 | otherwise, weekends |
| --- | --- | --- | --- | --- | --- | --- |
| factor | 1.15 | 1.3 | 1.1 | 1.4 | 1.15 | 1 |

A guess until drives in a big city measure it (the hours follow TomTom's public Traffic Index for Kyiv). Smaller
cities get none: drives through a regional city at the evening peak were free-flowing.

### 4.4 Checked against drives (`npm run route:eta`)

The planner's time for the road path each logged drive actually took, against the time it took: the drawn truth
where there is one (timed by the odometer), else the clean fixes' match, in ~2 km windows (stops over 2 min end a
window). `--by-road` gives real and planned km/h by class, setting and limit; `--costs '<json>'` tries other values.
With the model above the planned time is 8 % below the real one over the corpus (window p10/p50/p90 −39 / −12 /
+18 %); the class speeds alone were 25 % below. Still slow on short small-town drives (narrow streets).

## 5. Planner (`router.ts`)

### 5.1 Start and destination

- **Start**: the car's position and, when known, heading (the dot: map-matched while dead-reckoning). Candidate
  edges: the nearest, plus any within `max(25 m, accuracy)` and within 10 m of the nearest (a parallel road), but
  not those that only meet the nearest at its end node. Each allowed direction is a start state costing the rest of
  the edge; with the heading known, the direction against it costs the turnaround (§4).
- **Destination**: the nearest edge within 500 m, preferring a public road (not private, not minor service) when one
  is within 50 m of the nearest. Reached in either allowed direction at the projected point. Start and destination on
  the same edge with the destination ahead: the route is that stretch.
- **Road islands.** OSM has car parks, yards and track networks connected to nothing. Every other edge within 500 m
  of either end is a fallback end costing 3600 s plus 1 s per metre off (twice that at the start). The plan reports
  how far its ends are from the points (`offRoadM`); its duration leaves the penalties out. Before searching, each
  end's roads are followed regardless of direction up to 3000 edges: if that runs out without meeting the other
  end's roads there is no route, found in ~10 ms.

### 5.2 Search

- A\* over directed edges. `g` is the time to the end of the directed edge; expanding it takes the exits at its end
  node (`RoadGraph.exits`), drops the forbidden ones and adds junction, turn, entry and edge time. A state whose next
  edge is the destination edge in an allowed direction also offers the goal; the search ends when the goal is the
  cheapest open entry.
- **Heuristic:** straight-line distance ÷ the fastest speed, **weighted 1.5** (`HEURISTIC_WEIGHT`): routes at most
  1.5× the fastest in theory, within 0.25 % of it measured. An exact search floods the country on long routes.
- **Hierarchy pruning** (`HIERARCHY`): from 12 km off the nearer end only roads up to tertiary are searched, from
  35 km up to secondary, from 80 km up to primary; a node whose legal exits are all smaller roads keeps them; a
  pruned search that finds no route searches again with every road.
- **Weight fallback:** a search past 150 000 states (`FALLBACK_AFTER_STATES`) starts again at weight 2
  (`RouteStats.fellBackAt`, note `weight raised after n states`): a route much longer than the straight line (around
  the front line and the Dnipro) keeps weight 1.5's frontier wide. Routes under 150 k states plan exactly as before;
  the longest cross-country routes come out at most 8 % slower than at 1.5.
- Limit: `maxStates` settled states (default 2 M; failure "too far for the phone").
- Per state: typed arrays behind one map lookup, a typed-array heap, memoised headings, edge decoding without
  allocation (~2.5 µs per state in Node).

### 5.3 Output

`legs` (directed edges in order with `fromM`/`toM` along each edge's geometry), `lengthM`, `durationS`,
`coordinates` (lat/lon polyline), `startTurnaround`, `offRoadM`, and search stats (states, tiles, ms, `fellBackAt`).
Edge ids are those of the region's graph file, shared with the filter.

### 5.4 Slicing

`RouteSearch.run(maxStates)` advances by at most that many states and returns `done` or `more`; the app runs it in
slices of ~32 ms between frames (every yield waits about a frame for the next timer tick). `planRoute()` runs it to
the end (tools, tests).

### 5.5 Measured (`npm run route`, Node, cold tile cache)

City routes (≤ 15 km) plan in tens of ms, oblast routes in 0.1–1 s, cross-country routes in 1–5 s. Targets on the
phone: a city route under 0.5 s, an oblast route under 3 s; the app logs every plan's time (§8.2) and the phone's
own numbers on long routes are still to be read from the logs.

## 6. Instructions (`maneuvers.ts`)

`routeManeuvers(graph, plan)` gives `depart`, one maneuver per junction where the driver has to choose, and
`arrive`, each with its distance from the start, position and turn angle:

- **Choices.** At the end of each leg, the other legal ways on (not U-turns, one-ways against, restricted turns).
  From a main road, driveways, service roads, tracks, private roads and slip roads don't count. No other way: no
  instruction, however much the road bends.
- **Straight on.** The straightest way, turning less than 45°, needs none, unless another way of similar importance
  (road class at most one step lower) is within 35° of it: then `keep-left` / `keep-right`.
- **Turns** otherwise, by angle: `slight-*` under 45°, `left` / `right` up to 135°, `sharp-*` beyond; `u-turn` back
  along the same road (a dead end).
- **Roundabouts:** one `roundabout` maneuver at the entry with the exit to take (the legal ways off it passed on the
  way, plus one).
- **Turning around at the start:** a `u-turn` at 0 m when the route leaves against the car's heading
  (`plan.startTurnaround`).

## 7. Tools (`npm run route`, `route:bench`, `route:eta`, `route:sim`)

`npm run route -- --from lat,lon[,headingDeg] --to lat,lon [--graph <file>] [--geojson <out>] [--alternatives]`
prints the route and its instructions; `--bench <n> [--at lat,lon --radius km] [--alternatives] [--exact]
[--options '<json>']` plans random routes and prints planning time and states by distance; `route:bench` runs the
synthetic-grid benchmark of the hierarchy and weight; `route:eta` is §4.4; `route:sim` is §8.4.

## 8. App

### 8.1 Guidance (`guidance.ts`)

`RouteGuidance` takes each published position (the dot) and gives the state, the distance driven along the route, the
distance off it, what's left (metres, and the plan's time scaled by it), the next maneuver and the distance to it,
and the one after when it follows within 120 m.

- **Matching:** the closest point of the route's polyline between 100 m behind the last progress and 300 m ahead,
  plus 3 s at the current speed, plus 1.5 × the distance driven since the position last matched (after a detour the
  car rejoins further on); moving faster than 3 m/s, only stretches within 75° of the heading. Never the whole route:
  a route that passes the same street twice would make progress jump to the later pass.
- **Off the route** beyond max(40 m, 1.5 × the position's accuracy): `leaving` at once, `off` after 4 s and 30 m
  driven (from the speed, so a parked car or a jumping position never counts). `unsure` instead while map matching
  is `multimodal` or `init`, or the position is phone GPS that isn't trusted: neither on nor off is decided, and the
  count towards `off` pauses (restarting it hid a 700 m departure: while dead-reckoning map matching turns
  multimodal every 10–15 s). Driving the route the wrong way is off it. Until the car has been on the route once (it
  may start in a car park), `off` takes 200 m of driving instead of 30 m.
- **Arrived** within 30 m of the route's end along it, or of its last point once less than 300 m is left, and it
  stays arrived.
- A maneuver passed by less than 10 m is still the next one (the dot lags the turn).
- **Progress point**: the last polyline vertex passed and the point on the route; the map draws the route from there
  on (UI-SPEC §6.3).

### 8.2 Route service (`route-service.ts`, `runtime.routes`)

- `start(destination)` plans from the published position (with its heading, how sure, and accuracy) on its own
  reader of the active region's graph, in slices (§5.4), yielding to the UI in between.
- `off` (and not planning, and the wait below elapsed) plans again from where the car is; the old route stays drawn,
  faded. A failed re-plan keeps the old route and retries at the next `off` after the cooldown. A failed first plan
  ends in `failed` with the reason.
- **Not while map matching is `offroad`**: the filter says the dot is on no road, so `off` means "the car is lost",
  and a plan from a dot beside the road starts off it and goes off again at once. Unless the driver vouched for the
  dot: within 500 m of putting the car on the map (`PositionEstimate.sinceDriverM`), or standing where it parked off
  the roads (`parkedOffRoad`): there `offroad` is a car on a lot.
- **The driver puts the car on the map** off the route (not `on`): planned from there at once, whatever the wait or
  map matching says (reason `placed`). Each new `manual.placedAt` counts; "still here: yes" isn't one. A placing
  made while a plan is on its way is planned from once that plan is in.
- **The wait** starts at 10 s and doubles for each off-route plan whose route goes `off` again within a minute of
  being made, up to 160 s; a route that stays on for a minute, or that the car was on for 100 m along it, clears the
  streak (a plan that didn't survive its own first seconds didn't fix anything: the position was the problem; one
  the car followed 100 m did, and the driver took another way). The minute is measured from the plan to its route
  going off, never from one plan to the next. A flat 10 s cooldown re-planned a 62 km route 25 times in 12 min from a
  dot kilometres from the car.
- **The driver's own way** (`ownWay`): an off-route plan made after leaving an off-route plan the car never followed
  100 m along. The driver keeps to a way of their own (another navigator's): its route shows, but neither the voice
  (§8.5) nor the car's screen (ANDROID-AUTO-SPEC §4) announces it, until the car is on a route for 100 m along it.
  The first re-plan after a route the car followed is announced as ever. Notes: `route not followed again: guidance
  shown, not spoken`, `route followed: guidance spoken again`.
- Arrival ends the route a minute later; × ends it at once.
- The active destination is kept (kv-store `route.active`): an app restarted within 12 h plans it again from the
  first position, noted `route resumed after an app restart, to …`.
- **Trip log** (TRIP-LOGGER-SPEC §6.3): every plan (`nav_route`, with its polyline `nav_route_point` and maneuvers
  `nav_route_maneuver`), guidance at every published position (`nav_route_progress`), and notes: `route to …`,
  `route plan #n (reason): length, minutes, maneuvers; states, tiles, ms in slices (wall ms)`, `route plan #n failed:
  …`, `route off|on|unsure at <km>, <m> off, ±<accuracy>, <source>/<map match>`, `route arrived …: <min> (planned
  <min>), driven <km> (planned <km>)`, `route stop at <km> of <km>`. A route planned before the trip starts is
  logged again when it does (reason `resume`, on the recorder's `tripStarted` once the log is open); replays of
  older logs rebuild it (`routeBeforeLog`, `tools/replay/app-chain.ts`).

### 8.3 What to read from the trip logs

Planning time on the phone (`plan_ms`, `wall_ms`, `slices`) against Node's for the same route; ETA (`route arrived`
notes, `route:eta`); false "off route" while the car was on the route, especially while dead-reckoning, and late ones;
instruction timing (`to_next_m` when the car actually turned); re-plans (how often, where from, whether the new
route started on the road the car was on).

### 8.4 Simulated (`npm run route:sim`)

City drives from the simulator (MAPMATCH-SPEC §9.4), GPS for the first minutes then none, the replay's dot fed to
guidance as the app does. Following the route: no false "off", `unsure` 0.2 % of the time, progress off by ~5 m
median. Leaving it: every departure noticed, ~5 s and ~50 m after the car was 25 m off the route; no "off" before the
car left. Optimistic as the simulator is.

### 8.5 Voice (`announcer.ts`, `src/components/route/voice-*.ts`, `modules/audio-output`, `tools/voice/`)

- **Clips:** recorded phrases from a neural voice (Ukrainian `uk-UA-PolinaNeural`, English `en-GB-SoniaNeural`),
  whole phrases with the distance in words ("Через триста метрів, поверніть ліворуч"; digits get misread), so the
  intonation and the grammar of numbers are right. `npm run voice:render` records them into `assets/voice/<lang>/`
  (edge-tts, silence trimmed) and writes the clip index; a Jest test fails when the words changed without recording
  again. Each clip is compressed and brought to −15 LUFS, peaks under −1.5 dBFS: the loudest the voice plays. The
  default volume (80 %) plays it near −19 LUFS, Google's reference for mono voice. An announcement without a clip for
  every phrase (a roundabout exit past the 6th) is said by the system voice (`expo-speech`), which is silent with the
  ring/silent switch on.
- **Playback:** `expo-audio`, clips one after another, other audio lowered meanwhile, also with the silent switch on
  and in the background (the plugin's background playback). The voice goes wherever the phone's audio goes (a car's
  Bluetooth while connected; silent when the car plays another source, which the app can't tell). When that output
  goes away expo-audio pauses its players and never resumes them: a clip paused that way is played again from its
  start (twice at most). Holding the banner's voice button opens the system's output picker and the button shows
  where the voice goes (`modules/audio-output`: iOS Apple's picker; Android the output switcher (14+), the media
  output dialog (12–13), the Settings panel (11), else Bluetooth settings). `playOnSpeaker` plays a clip on the
  phone's own speaker on Android (the "place the car" prompt, UI-SPEC §6.2). While Android Auto is connected,
  `playGuidance` plays the clips on Android's own player as navigation guidance, which the car mixes over whatever it
  plays (ANDROID-AUTO-SPEC §3); one that won't play that way goes through expo-audio. While a CarPlay session is open,
  expo-audio's session is set to the voice-prompt mode with spoken audio interrupted and others ducked (`setVoicePrompt`,
  after expo-audio sets its own category), as Apple asks of navigation apps: CarPlay mixes it over the car's audio
  (CARPLAY-SPEC §4); before each announcement the session's `promptStyle`, and nothing is said when it asks for none
  (a call, Siri) or a short tone.
- **When:** each maneuver is said twice. Ahead of it at a spoken distance (50, 100, 200, 300, 400, 500, 600, 800 m,
  1, 1.5, 2 km), the first at or beyond max(250 m, 15 s at the current speed). At it, early enough to hear, react and
  slow down (`nowDistanceM`): 10 m before the maneuver point + 2.8 s at the current speed + braking at 2 m/s² to the
  maneuver's speed (20 km/h a turn, 15 a sharp turn or U-turn, 25 a roundabout, 50 a slight turn or keep), at least
  40 m. "Ahead" is skipped when "at it" would follow within 6 s. "потім …" when the next follows within 120 m; "і ви
  на місці" for the destination; roundabout exits as ordinals; "Маршрут перебудовано" for a re-plan, "Ви прибули" at
  the end. Nothing about the plan's maneuvers while off it. Taking an alternative (either way) says nothing of
  its own. Neither an alternative taken nor a re-plan says again what was said of the same maneuver (same kind and
  exit, within 20 m) still as far from the car (within 100 m): the turn at a junction the routes share is said once,
  and a turn missed and reached again round the block is said again. Turning around at the start, not made yet, is
  one maneuver wherever the car is when planned: a re-plan while the car drives on away doesn't say it again. Re-plans
  in a row with nothing said between them say "Маршрут перебудовано" once. On the driver's own way (§8.2's
  `ownWay`) nothing is said but arrival. `npm run replay:voice` checks "turn now" against when
  the car turned (the gyro).
- **Controls:** the banner's speaker button mutes it (kept across launches). Settings has the volume, 0–100 % (a
  sample is said when the finger leaves the slider; 0 turns the voice off and hides the button). The player's gain is
  the square of the setting, so equal steps sound about equal; it applies to the clips and the system voice.
- **Trip log:** `audio output: <kind> "<device>", volume <n> %` when a route starts and `audio output now: …` on each
  change (speaker, receiver, wired, bluetooth, carplay, airplay; on Android `; all: …` and `capture` for a screen
  recording or cast), `voice say <phrase ids>` per announcement (`(system voice)` without clips, `after <n> waiting`
  when queued), `voice muted: …`, and what went wrong (a clip that never ended, one that didn't load, the system voice
  failing, a clip paused by the system and played again). Whatever the player does, the next announcement is said.

### 8.6 Route hint (removed)

The route as a prior for the particle filter's junction choice was measured in the simulator and removed: the filter
already held the road, and a strong factor hid real departures. Don't bring it back without a road case where map
matching fails without it. (The route does tip which hypothesis the *dot* draws: MAPMATCH-SPEC §11.)

### 8.7 Alternative routes (`alternatives.ts`)

After a new route (reason `new`), up to two other ways to the destination.

- **Search (penalty method):** the planner runs again with every road of the routes kept so far slower by 1.4×
  (`RouteOptions.avoid`, left out of the plan's `durationS`). A result is kept when it takes at most 1.3× the main
  route's time and at most 20 min more, and at most 60 % of its length is on the roads of any route kept so far. At
  most 3 searches.
- **Never in the way of the route:** the main plan is published and guided first; the alternatives search runs after
  it in its own slices, and a re-plan, arrival or stop cancels it. Note `route alternatives: n (+m min, km, % shared)
  …; searches, states, ms`.
- **A faster one takes over:** the weighted heuristic can miss the fastest route; an alternative at least 30 s faster
  replaces it while the car is within 50 m of the start (`route alternative taken (faster)`).
- **Choosing:** a tap on a grey route or its label makes it the route (`chooseAlternative`, logged as a plan with
  reason `alternative`); the route becomes an alternative.
- **Driving one:** each alternative is followed by its own guidance. When the route goes `off` while an alternative is
  `on`, that one becomes the route instead of planning again (`route alternative taken (taken)`). On the route and
  off every alternative, they go away.
- **Map** (UI-SPEC §6.3): quieter lines under the route, each labelled with its time against the route. They come
  while the car stands: the map frames all routes once.
- **What sets each apart** (`route-via.ts`): the street its own stretch runs along, where it is over 40 m from every
  other route: points every 75 m there (at most 12, spread over it) each ask the search index for their nearest
  house's street within 60 m, and the most named wins (the road graph has no names). The car's routes list titles
  each route by it (ANDROID-AUTO-SPEC §4).

## 9. Verification

1. Unit tests: cost model, planner on the fixture graph (restrictions, one-ways, turnaround, islands), maneuvers,
   guidance states, announcer timing, alternatives; the voice clip index matches the phrases.
2. `npm run route:sim`: no false "off" while following, every departure noticed.
3. `npm run route:eta` after a cost change: the corpus no further from the real times.
4. On the road: the banner's maneuver and distance against the junction; "turn now" before the car slows for it.

## 10. Open items

1. Street names in instructions: a name table in the graph (format change).
2. Rush hours from drives in a big city at its peaks; the shares (§4.1) from more drivers than one.
3. Planning time on the phone for long routes (§5.5).
4. Kyiv road closures (data.gov.ua, CC BY) as an online add-on fetched once a day for the whole city (no position
   sent).
