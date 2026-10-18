# replay — run trip logs through the navigator

Feeds a trip log (`*.ulg`) through `src/nav` (the Stage 1 EKF) in Node on Windows, the same code the app runs
(SPEC §3.10). Node 24 runs the TypeScript directly; `register.mjs` resolves the `@/` alias and extensionless imports.

```bash
npm run replay -- tools/triplog/logs/*.ulg                       # summary per log
npm run replay -- trip.ulg --cut 120:300                         # simulated GNSS outage: 300 s from t = 120 s
npm run replay -- trip.ulg --cut 120:60 --cut 400:300            # several outages
npm run replay -- trip.ulg --open-loop 60                        # no GPS from 60 s after the heading fix to the end
npm run replay -- trip.ulg --geojson tools/triplog/logs/trip.geojson
npm run replay -- trip.ulg --lag 0.5                             # fixed GNSS position/course lag (default: measured from turns)
npm run replay -- trip.ulg --sweep-lag                           # pre-fix error per fixed lag (can't see a constant lag; prefer the measured one)
npm run replay -- trip.ulg --json                                # summary as JSON
npm run replay -- --chain a.ulg b.ulg c.ulg                      # each log starts from the pose the previous one parked in
npm run replay -- --app-cuts trip.ulg                            # cut where "Cut GPS" was on in the app (also replay:mm)
npm run replay -- trip.ulg --spoof 300:60                        # simulated spoofing: from 300 s for 60 s, a static fix 5 km east
npm run replay -- trip.ulg --spoof 300:60:static:300:0           # … 300 m north (kind:distanceM:bearingDeg)
npm run replay -- trip.ulg --spoof 300:inf:outside               # … abroad (Minsk) to the end; offset: the real fixes moved
```

On PowerShell, `npm run x -- --flag` loses the `--`; run `node --experimental-transform-types --no-warnings --import
./tools/replay/register.mjs tools/replay/cli.ts …` (the script's command) instead.

## Regression check

Run it before and after any change to the navigator or map matching: every drive through the app as the viewer
replays it, with several filter seeds, scored drive by drive, from three starts:

- **parked:** every log in order on one storage, each drive starting from what the earlier ones left (the app's
  own chain);
- **drawn:** that chain, but each drawn drive starts parked where its drawing starts, heading from the drawing and
  the gyro (MAPMATCH-SPEC §10.2): the spot saved right, whatever the chain or the phone made of it;
- **cold:** nothing stored, scored only from the first fix claiming ≤ 150 m (a drive without one isn't scored).

Judge a change by parked and drawn; cold shows how the app copes with nothing, and must not fall apart.

```bash
npm run replay:regress -- --save before          # keep this run (tools/triplog/logs/regress/before.json)
npm run replay:regress -- --against before       # every drive against it: what got worse, what got better
npm run replay:regress -- --seeds 5 --starts parked --logs 20261005 --nav '<json>' --mm '<json>'
npm run replay:regress -- --from after --against before   # two saved runs, nothing replayed
```

- **Truth, per drive, best first:** the roads drawn for it in the viewer (*Ground truth*, below), else its clean
  satellite fixes (the dot when GPS came back after each gap, and at its worst through the app's Cut GPS
  stretches), else its Wi-Fi fixes (10–150 m; the dot just before each, a rough check). Most jammed drives have
  only the last, so draw the ones that matter.
- **On every drive, truth or not:** seconds the dot was more than 20 m from every road above 20 km/h, and its jumps
  (the viewer's hollow circles), and from the parked chain how far each drive started from where the last one's dot
  stopped.
- **`--against`:** a drive is worse when the median over its seeds grows by half again plus a floor (20 m, 10 s, 2
  jumps), or its worst seed by half again plus 2.5 floors (one seed in three lost is a finding). Each line shows
  the seeds before → now. The totals come last, per start: on 2026-10-07 they read fewer jumps overall for the two
  changes that broke 8 drives.
- One seed in three going bad is often the filter's luck: before keeping or dropping a change on such lines, run
  `--seeds 8` on both.
- About 2 min for every log, three starts, three seeds on 32 cores, at low priority. It replays the app's settings (`app-defaults.ts`), not
  the version a log was recorded with, and gives the dot the routes the log planned, as the app does.
- **Incidents** on drawn drives: the moments a driver would see go wrong (next section), counted per seed; a drive
  is worse when they grow.
- `--testers` adds the testers' drawn drives, each folder on its own chain (its phone's storage).
- **Memory:** each worker holds a road graph and a drive (~0.5–1 GB). Pass `--threads 8` and run one benchmark at a
  time: four side by side ran a 32 GB laptop out of memory.
- `--puck '{"headingCueFactor":1}'` switches the dot's heading cue off (`position/puck.ts`) for a before.

## Incidents and simulated Kyiv drives

What a driver would see go wrong with the dot, moment by moment, against the truth (MAPMATCH-SPEC §10.2): lost,
arrow against the car, another road, far along the road, jumps, steps back. A replay that judged nothing fails.

```bash
npm run sim:drives -- --seeds 1-3 --threads 6             # 20 Kyiv trips × 3 drives × GPS all along / lost / spoofed
npm run replay:incidents -- tools/triplog/logs/synthetic --threads 10 --json runs/before.json
npm run replay:incidents -- tools/triplog/logs/synthetic --threads 10 --json runs/after.json --against runs/before.json
npm run replay:incidents -- tools/triplog/logs/synthetic --only lost --seeds 4 --mm '{"maxCompareM":15}'   # an experiment
npm run replay:incidents -- tools/triplog/logs/emulator/*.ulg --exact-timing --minor   # emulated drives, every incident
npm run replay:view -- --logs tools/triplog/logs/synthetic
```

- **Simulated drives** (`sim-drives.ts`): each trip on the route the app's router plans, driven by
  `src/nav/sim/city-drive.ts` (speeds, stops, lanes, the phone's sensor errors), saved as trip logs in
  `tools/triplog/logs/synthetic/` (git-ignored) with `.truth.json` (the path, for the viewer) and `.sim.json` (where
  the car was every 0.2 s: exact timing). GPS goes wrong 200 s in; spoofed and lost score the same while the
  integrity check refuses every spoofed fix.
- **Scenarios** (the log name's last part): `gps`, `lost` (no fixes from 200 s), `spoof`, `jam` (Wi-Fi/cell-like fixes
  from 200 s, `src/nav/replay/jam.ts`), `jamstart` (jammed from the start, the replay given the parked pose and the
  speed scale a car that drove before has), `unmapped` (jamstart, and two short roads of the route missing from the
  navigator's map, `hidden-roads.ts`). Judge a change on `jam`/`jamstart` before the real drives: changes that won on
  `lost` and lost on the real drives came out worse there too (2026-10-16). Not yet on how many Wi-Fi fixes may move
  a lost track: every simulated scenario prefers more, the real drives need three (MAPMATCH-SPEC §9, NAVIGATOR-SPEC §7).
- Pass a folder, not `*.ulg`: 180 paths are past a Windows command line. `--only lost,demo` keeps logs whose names
  contain one of them. About 15 min for all 180 × 8 seeds on 10 threads, 3 min for the 60 lost ones × 4.
- **When a driver sees something no incident reports,** fix the detector first and show it fires on that log, then
  the navigator.

## Spoofing benchmark

```bash
npm run replay:spoof -- tools/triplog/logs/*.ulg                # GNSS integrity against simulated spoofing
npm run replay:spoof -- tools/triplog/logs/*.ulg --any-start    # also before the heading is known
```

Every clean drive gets 60 s windows (every 120 s, from 30 s after the EKF starts) of each kind of spoofing
(`src/nav/replay/spoof.ts`), and the same windows cut as a control. Per kind: is the first spoofed fix refused, how
many spoofed fixes the navigator used, when trust came back, how far off the dot was when real GPS returned
(against the cut), and any real fix refused or untrusted time away from the spoofing. Windows with a problem are
listed (`--verbose`: all). The summary of `npm run replay` has an `integrity` line too.

Keep outputs in `tools/triplog/logs/` (git-ignored). They contain coordinates.

## Outage benchmark

```bash
npm run replay:bench -- tools/triplog/logs/*.ulg                                  # current settings
npm run replay:bench -- tools/triplog/logs/*.ulg --nav '{"ekf":{"gyroNoise":0.001}}'  # try a variant
```

- **Windows:** hides GPS for 60, 120 and 240 s, starting every 30 s of log time from 10 s after the EKF starts
  (a fixed grid, so two variants score the same windows). A window counts only if the hidden satellite fixes
  cover ≥ 80 % of it and the car drives ≥ 200 m, so only clean-GPS stretches score. Windows where the phone
  left the car (≥ 5 satellite fixes moving while OBD reads 0 or is silent: the driver walking off with it) are
  skipped.
- **Output, per outage length:** max and end error (median and p90), end error per km, and `err/σ`.
  - `err/σ` is max error ÷ the predicted 1σ. Below 1 means the filter is too pessimistic; above about 2 means
    it's overconfident.
- **Caveats:**
  - Windows overlap, so small differences between variants are noise.
  - It takes a few minutes. Run variants in parallel shells.

## Map viewer

```bash
npm run replay:view                 # http://127.0.0.1:5174 (add -- --open to open the browser)
npm run replay:view -- --logs D:/trips --port 5180
```

The viewer answers "how did my drive go": where the dot was against where the car really was.

It replays a drive through the app's own `NavigatorService` (`src/services/navigation/app-replay.ts`), not a
navigator alone: inputs arrive as on the phone (IMU in 100 ms batches, OBD when its reply came, fixes after
CoreLocation's delivery delay) on a virtual clock, and the blue track is what the service publishes, the record the
phone writes as `nav_estimate`. So the replay can't drift from the app: the reorder window, the parked pose per car
(started from, confirmed, saved every 30 s, dropped once the car moves), the speed scale, GNSS lag and compass from
storage, and the "Cut GPS" outages are the app's code. *Experiment*'s research options (a later start, a fixed GPS
lag, the compass at a jammed start) replay the navigator alone (`replayTrip`), as the benchmarks do; the status
line then says so.

- **Header:** the drive (newest first; ‹ › step, the name opens the list, `/` too; its second line says how long,
  how far and how GPS was), the three modes, and the status: how the replay started, and in amber what it does
  differently from the drive as it happened. In the list, *Delete this drive…*, or tick drives (*Select all shown*
  ticks what the search shows: "undrawn", a day, a tester) and *Delete selected…* — each asks once more — removes
  junk logs and their drawings here, and from the bucket on the next `npm run logs:push` (tools/triplog/README.md);
  deleting the drive open moves to the nearest one left. The replay runs the navigator the drive was recorded with
  (the log header; the app runs full correction, MAPMATCH-SPEC §9). It runs in a worker thread on the server: picking
  another drive (or setting) while one replays stops it at once, and the server answers the rest of the page meanwhile.
- **Review** — did the dot get this drive right:
  - *Verdict*: against your drawing, how many places a driver would have noticed the dot wrong, the share of
    driving on the right road (within 30 m of the drawn road, near where the car was), the typical distance from the
    car and where it parked. Not drawn: the stretches without GPS are all it can score.
  - *What went wrong*: the incidents (MAPMATCH-SPEC §10.2) in words, each with its time and how bad; click one to go
    a few seconds before it; *show small ones too* adds the minor ones and those while lost.
  - *At the cursor*: the GPS state, and each dot's distance from the newest clean GPS fix (or from the drawing
    without one), inside its circle or not.
  - *Without GPS*: every stretch without good GPS. *No GPS*: no clean satellite fix for over 15 s (jamming,
    tunnels) while the car moved at least 30 m; scored by how far off each dot was when GPS came back, and whether
    that was inside its circle. *Cut GPS (app)* and *Cut in replay*: GPS was there but withheld, so each dot is
    scored all through: at the end, at worst, and how often the real position was inside its circle (honest ≈ 68 %).
    Click one to zoom to it and jump to its end. Code: `src/nav/replay/drive-report.ts`.
  - *Everything the replay logged* (folded): events (markers, starts, navigator and map-matching changes, GPS
    trust; link and sensor messages on request) and the replay's internals.
- **Draw the truth** — the roads the car took, for a drive GPS can't score (MAPMATCH-SPEC §10.1). Every change is
  saved at once as `<log>.truth.json` beside the log (git-ignored with it); Esc or *Done* goes back to Review.
  - The toolbar on the map: *Along roads* (R) — the server lays the shortest way along the roads between two
    clicks, one-ways ignored (the car went where it went, and OSM is sometimes wrong). Clicks more than 12 m from the
    map's roads, two in a row or at the drive's start or end, are off them anyway: the line goes straight between
    them and to the nearest road. *Off the roads* (O): clicks stay exactly where you put them however near a road
    (`free` points, filled squares), joined straight — a car park beside the road. *Add before the start* (S): clicks
    go before the first point, to draw a start you missed. Shift-click draws a straight stretch anyway (or toggles
    it on a point), Alt-click toggles a point on or off the roads; drag a point to move it, right-click to delete it,
    click the line to add one in between; Ctrl+Z or *Undo* undoes. Layers fold away while drawing.
  - *Gyro path* (dashed violet; a layer, on in every mode): where the car's own gyro and wheels say it went, 90 s
    either side of the cursor, laid on the drawing at the cursor and turned to its direction there (`odometryTrack`,
    app-chain.ts). Put the cursor where the drawing is surely right and check the car park or yard next to it;
    against GPS it was within ~10 m 30 s from the cursor and ~15 m at 60 s (median).
  - *Checks*: the drawing against the odometer (they agree within a few % when it is right); where the drawing
    turns differently from the gyro (more than 60° over 24 s, the drawing's timing allowed 20 s either way); where
    3+ Wi-Fi fixes in a row are far from the drawing, or beside it far along from where its timing has the car (a
    stretch missing or drawn twice); stretches drawn straight for want of a road route. *Show* goes there.
  - *Your placings*: where you put the car on the phone, with its heading on the map, a dashed line to where the
    drawing has the car then, and that distance: far apart, one of them is wrong.
  - The car's place on the drawing every second comes from the odometer — the speed the app drove on: OBD, or the
    CAN wheels on a log recorded with CAN primary, which polls OBD only standing — pinned at the drive's ends
    (start where it was parked, end where it parked) and at any clean fix. Where the drawing and the odometer
    disagree, the straight stretches take most of it (their length is a guess; a road's isn't). The timing's doubt
    grows by 3 % of the odometer distance to the nearest pin. Code: `src/nav/replay/drawn-truth.ts`.
- **Experiment** — replay the drive as if something had been different (the phone's own track never changes);
  *Back to as it happened* undoes it all:
  - *What if GPS had been…*: as on the phone (your "Cut GPS" moments withheld); cut for a while (`120:240`, several
    with commas); jammed (Wi-Fi/cell-like fixes only, all drive or a window; `src/nav/replay/jam.ts`); gone after the
    start (pure dead reckoning once the heading is known); good all along.
  - *Where the car started*: where the phone remembered it (default: what the app had stored when the drive
    started — parked pose, speed scale, compass, GNSS lag, a manual position — from the log's `nav storage` notes;
    a log from before 2026-10-11 falls back to the next); where your drawing starts (its parked pose at the drawn
    start, heading along it); where today's navigator would have parked it (every earlier log replayed in order
    through the app with one storage across them, NAVIGATOR-SPEC §6.1, the car by its VIN, else the car last seen on
    the same OBD protocol: ~35 s the first time, kept until the viewer restarts); nowhere (a fresh install).
  - *Compare with*: a second version, drawn in orange. *Before 16 Oct*: the dot without the heading cue or the
    steadying along its road (MAPMATCH-SPEC §11). *Open loop*: no corrections from the map into the navigator.
  - *Adapter*: as recorded (the speed the app took, OBD or the CAN wheels), or none: phone-only mode
    (NAVIGATOR-SPEC §9.6), fed no OBD speed or engine states; the dot is the phone's own dead reckoning wherever GPS
    isn't good, the timeline draws its speed over OBD's, rings around the dot are the other roads its tracker holds.
  - *Research options*: your placings replayed (as on the phone: the car put where you put it, at that moment) or
    ignored, GPS lag (empty = learned), a later start, the compass at a jammed start (MAPMATCH-SPEC §8.2), and clock
    times local or UTC.
- **Layers** (on the map): *Where the dot was* — the replay in blue, what the phone showed in cyan (from the log's
  `nav_estimate`; older logs don't have it), the compare replay in orange, and distance lines to where the car was;
  *Where the car really was* — your drawing, the gyro path, your placings, GPS fixes (green satellite, amber
  Wi-Fi/cell; hover for details, click to jump), the path matched from GPS; *Background* — streets or satellite
  photos (Esri World Imagery: where the map lacks a yard, a car park or a new road); *For debugging the navigator* —
  its road graph, its map-matching particles, the planned route. A replay track is what the app would have shown
  (what its service published). Where the dot jumped (farther between two samples than 45 m/s + 10 m) the line
  breaks and both ends get a hollow circle: where it went in between is unknown.
- **Timeline:** click or drag to seek; Space plays and pauses; ← and → step 5 s (Shift: 30 s).
  - *Off by*: each dot's distance from every clean GPS fix (log scale, 1–300 m), dashed from the drawing; dots on a
    line mark moments outside its circle. Shaded: stretches without GPS (grey no GPS, amber Cut GPS, blue cut in the
    replay).
  - Speed (OBD), and GPS quality (green good, pale weak, amber Wi-Fi/cell only; red ticks are your markers).
- **Links:** the URL keeps the drive, the mode, every setting and `t` (seconds), so a link reopens the same view.
- The server runs under `node --watch`, so it restarts itself when `src/nav` or the viewer code changes; reload
  the page afterwards. A server started before this change has to be stopped by hand once.

The server only listens on localhost. The basemap is the online OpenFreeMap Liberty style, so your browser
sends the map viewport to OpenFreeMap (and to Esri with the satellite background on).

## Simulated city drives

Hours of driving without GPS, on a real road graph (MAPMATCH-SPEC §9.4): random routes, a car that drives them
like a driver, and the phone's sensors with measured errors (`src/nav/sim/city-drive.ts`). GPS for the first
minutes, then none; each navigator version is scored against the exact truth every second.

```bash
npm run replay:sim                                       # default graph, 60 min, seeds 1–3, open vs closed loop
npm run replay:sim -- --minutes 180 --imu-hz 50 --every 30
npm run replay:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin
npm run replay:sim -- --loops open,heading,closed --gps-min 5
npm run replay:sim -- --route arterial --trace               # main roads, straight on: few turns; a line per 5 min
```

Per drive: distance, junctions, stops; per version the dot's error (median, p90, max, at the end), the share of
time more than 50 m off and the longest such stretch, the navigator's own error, and the road corrections sent. Then
the error by time without GPS (`--every` minutes). Graphs: `--graph`, else the smallest built one covering `--at`
(`curl -fo tools/tiles/out/release/<region>.graph.bin "$UPDATES_ORIGIN/maps/<date>/<region>.graph.bin"` fetches a
published one).
It is optimistic: no parking, reversing, yards, unmapped roads or traffic jams.

## Routes

The app's route planner (ROUTING-SPEC, `src/nav/routing/`) on a region's road graph: one route, or the planning
time of many random ones.

```bash
npm run route -- --from 50.4501,30.5234 --to 50.4600,30.6000            # one route; --from lat,lon,headingDeg
npm run route -- --from 50.4501,30.5234 --to 49.7988,30.1153 --geojson route.geojson
npm run route -- --bench 50                                              # random routes in the region
npm run route -- --bench 50 --at 50.4501,30.5234 --radius 8             # ... within 8 km of a point
```

One route: length, time, edges, its turn instructions, how far its ends are from the points, states settled, tiles
read and planning time (`--geojson` writes the line and the maneuvers). The bench prints planning time, states and
the route's length over the straight line by distance, and the `--from`/`--to` of every route that failed.
`--alternatives` adds the alternative routes (ROUTING-SPEC §8.7): for one route each with its time and share on the
main route's roads (and in the GeoJSON); for the bench how often there are some, how much slower and how different,
and the search time.

Route times against the logged drives (ROUTING-SPEC §4.4): the planner's time for the road path each drive actually
took, against the real time, in ~2 km windows.

```bash
npm run route:eta                                        # every log: drawn truth, else the clean fixes' match
npm run route:eta -- --by-road                           # real and planned km/h by class, setting and limit
npm run route:eta -- --costs '{"signalS":20}' --no-rush  # other cost values; free-flowing
npm run route:eta -- --graphs <dir>                      # graph files from elsewhere (e.g. freshly built)
```

Guidance on simulated drives (ROUTING-SPEC §8.4): false "off route" while the car follows its route without GPS,
and how soon guidance notices when it leaves one.

```bash
npm run route:sim                                        # default graph, 60 min, seeds 1–3, GPS for the first 3 min
npm run route:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin
npm run route:sim -- --gps                               # GPS all along
```

In `replay:view`, a drive with a route shows it in pink (the plan in force at the cursor; replaced plans grey and
dashed), its maneuvers, a Route panel (each plan, its planning time, "off route" count, arrival) and a "route" strip
on the timeline: pink on the route, amber leaving it, red off it, grey unsure; ticks mark plans.

## Road graph

Map matching runs on the road graph built by `tools/tiles` (`python -m tiles.cli graph kyiv`, see its
README; MAPMATCH-SPEC §4–5). Tools pick the smallest `tools/tiles/out/release/*.graph.bin` with roads at the
trip's first fix, so the oblast rather than Ukraine; `--graph <file>` overrides.

```bash
npm run replay:graph -- tools/triplog/logs/*.ulg                       # graph vs clean fixes, reader timing
npm run replay:truth -- tools/triplog/logs/*.ulg                       # ground truth: which road, breaks
npm run replay:mm -- tools/triplog/logs/*.ulg                          # map matching vs the ground truth
npm run replay:mm -- trip.ulg --cut 241:240 --trace 330:360            # one outage, second by second
npm run replay:bench -- tools/triplog/logs/*.ulg --mm                  # outage benchmark with map matching
npm run replay:bench -- tools/triplog/logs/*.ulg --jam-start --verbose # heading init under jamming, with and without the map
npm run replay:bench -- tools/triplog/logs/*.ulg --jam-start --compass   # …and with a compass calibrated on the other drives (right, turned 90°/180°)
npm run replay:compass -- tools/triplog/logs/*.ulg                        # what the app logged about the compass in shadow (NAVIGATOR-SPEC §7.6)
npm run replay:bench -- tools/triplog/logs/*.ulg --speed can --mm        # the navigator on CAN wheel speeds where heard (NAVIGATOR-SPEC §5.3)
npm run replay:regress -- --speed can --yaw wheels                       # and turning on the rear wheels, as the app does (NAVIGATOR-SPEC §5.4): a phone in a pocket
npm run replay:regress -- --speed can --yaw wheels --yaw-from 120 --yaw-cal   # experiment: the gyro until 120 s, then the wheels with the learned tyre term
npm run replay:regress -- --speed can --yaw wheels --yaw-gaps gyro       # … the gyro between listening windows: what listening without breaks would give
npm run replay:voice -- tools/triplog/logs/*.ulg                          # "turn now" vs when the car turned (gyro), per followed turn (ROUTING-SPEC §8.5)
npm run replay:can -- tools/triplog/logs/*.ulg                            # CAN shadow frames decoded: wheel/CAN speed vs 010D and GNSS, gear, steering (SPEC §3.2); the adapter's stops, throughput, filter test
npm run replay:can -- trip.ulg --profile toyota/toyota/toyota_nodsu_pt_generated # …through a given profile (make/mapping/DBC)
npm run replay:mm -- trip.ulg --start 300 --jam 300:inf --trace 300:420 # one jammed start, second by second
npm run replay:places -- --mm '{"particles":1000}'                    # jammed drives scored by where they end (places.json)
npm run replay:crossings -- tools/triplog/logs/*.ulg                   # roads the true path crossed away from junctions
npm run replay:doubt                                                   # the dot's doubt from Wi-Fi/cell fixes over every log (NAVIGATOR-SPEC §6.1a)
npm run replay:offroad -- trip.ulg                                     # samples with the dot off every road above 40 km/h
npm run replay:junction -- --graph <file> --at lat,lon                 # the roads around a junction, for a test fixture
npm run replay:imuspeed -- tools/triplog/logs/*.ulg [--chain]          # the phone's own speed estimate against OBD (NAVIGATOR-SPEC §9.7)
npm run replay:turns -- tools/triplog/logs/*.ulg [--along] [--route]   # phone-only turn-anchored map matching on the jammed drives
npm run can:profiles                                                   # regenerate src/nav/odometry/can/signals.json from the opendbc submodule
npm run voice:render                                                   # record the spoken maneuvers (ROUTING-SPEC §8.5)
npm run replay:parity -- tools/triplog/logs/*.ulg                      # does the app replay reproduce the phone's dot?
npm run replay:graph -- --graph tools/tiles/out/release/ukraine.graph.bin trip.ulg
npm run replay:view -- --graph tools/tiles/out/release/kyiv.graph.bin  # viewer with a given graph
```

- **`replay:graph`:** for each clean moving satellite fix (≤ 10 m, ≥ 3 m/s): the distance to the nearest road,
  the share farther than 15 m (missing roads, parking lots), and the GNSS course against the road heading.
  Then the reader's cost: open time, tiles loaded, `edgesNear` from cache and with tile loads.
- **`replay:truth`:** ground truth for map matching (MAPMATCH-SPEC §10.1): an offline HMM matches the clean
  satellite fixes (≤ 10 m) to roads, scoring routes against the OBD distance. It prints the chains and every
  break (off the graph, gap, no route) with time and place, how far moving fixes are from the road, the route vs
  OBD vs navigator odometry distance, and any legs that don't fit or needed a one-way/restriction/U-turn penalty.
  `--json <out>` saves the matched points, legs and breaks.
- **`replay:mm`:** runs the particle filter (MAPMATCH-SPEC §7, open loop) in the replay and scores it against
  the ground truth: how the EKF started, wrong-road rate, truth survival, multimodal and off-road shares, re-lock
  time, update time, and the stretches where it was on a wrong road or lost the true one. Samples in state `init`
  (heading unknown, MAPMATCH-SPEC §8) count only for truth survival. With `--cut`, the filter's and the EKF's
  error at the held-out fixes. `--trace from:to` prints, per second, the navigator mode, the filter state and
  particle count, the top clusters (OSM way, weight, spread), the true way and both errors. `--mm '<json>'`
  overrides the filter's config; `--start <s>` and `--jam <start:len|inf>` as in the viewer.
- **`replay:bench --mm`:** the outage benchmark with the filter's error next to the EKF's (dominant cluster,
  off-road clusters included). With the map the EKF can start earlier (from the map), so its own columns differ
  a little from a run without `--mm`.
- **`replay:bench --jam-start`:** the heading-init benchmark (MAPMATCH-SPEC §8). Every log runs as recorded, and
  clean ones also as sessions starting every 60 s (`--every`) with jamming from the session start to the end. Each
  session runs without and with the map. Per session: how the EKF started, when, after how much driving, and the
  heading and position error at the start, also ÷ the σ it started with. The reference is the ground truth, else a
  clean replay's EKF, else (heading only, marked `gyro`) the clean replay's later heading taken back by the
  gyro. `--verbose` prints every session.
- **Seeds:** the filter is random, and one run of it is too noisy to compare changes by (single sessions flip
  between a map and an alignment start). With the map, both benchmarks run every window or session with 3 seeds
  and pool the results (counts are over windows or sessions × seeds; slower by as much). `--seeds N` changes the
  number, `--seeds 1` for a quick look; the first seed is `--mm-config`'s `seed`, else 1. Without the map nothing
  is random and it runs once.
- **`replay:places`:** jammed drives have no truth on the way, but they start and end at places known to a few
  metres (home, a parking spot). `tools/triplog/logs/places.json` (git-ignored with the logs: it says where people
  live) lists the places and, per drive, its log, start pose and end place (format at the top of `places.ts`). Each
  drive replays from its start pose with 5 seeds (`--seeds`); per drive the median end error, the runs ending
  > 50 m off, the off-road share while moving, and the roads the off-road cluster drove straight across away from
  junctions (`replay:crossings`). `--nav` / `--mm` as above, `--name` labels the run.
- **`replay:parity`:** each log replayed through the app (`app-replay.ts`) from what the app had stored (the log's
  `nav storage` notes) with the navigator version the phone ran, its dot against the phone's `nav_estimate`
  (median, p90, max and where). With no navigation commit since the log's build (`ver_sw`) a p90 over 3 m is
  flagged: the replay doesn't reproduce the app (exit code 1). Logs before 2026-10-06 have neither the build nor the
  notes; on them clean-GPS drives still agree to ~0.1 m, jammed ones show what changed since.
- **`replay:crossings`:** a car crosses a road only at a junction (`src/nav/mapmatch/road-crossing.ts`: from clear
  of it on one side to clear of it on the other, ≥ 25 m from an edge's end, no bridge or tunnel near, driveways and
  parking aisles left out). Run on the clean satellite fixes it shows how often a real path seems to (GPS noise,
  OSM geometry): 0 on the 12 clean drives so far.
- **Threads:** `replay:bench` (both modes), `replay:mm` and `replay:places` replay their windows, sessions, drives
  and seeds on worker threads (`tools/replay/pool.ts`), all cores but one; `--threads N` to change that. Results
  are gathered in order, so the output is the same as on one thread. Every tool runs at low OS priority
  (`register.mjs`; the viewer below normal), so it takes the whole CPU only while nothing else wants it and several
  can run at once without freezing the desktop.
- **Outage windows:** `replay:bench` replays each drive once per seed up to each window start and runs the window
  on a fork from there (`TripReplay`, NAVIGATOR-SPEC §10): the longest window from a start, the shorter ones forked
  off it at their own end, each stopping 5 s after its end. Windows whose satellite fixes can't reach the truth
  share (jammed drives) are left out before any replay, and with `--mm` so are logs with no fix to place a graph
  or no graph covering them (`skipped …`). The results are the same as a replay per window from the drive's
  start. On 32 cores and the 27 drives of 2026-10-07: `--mm` 33 s (354 s before the forks), without it 12 s (177 s).
- **Viewer:** the *roads* checkbox draws the graph around the trip's fixes, under the tracks: major roads thick,
  service roads and tracks dashed, arrows on one-ways (zoom ≥ 14). At zoom ≥ 15 it adds junctions, dead ends
  (orange) and region-boundary ends (red). Hover for the OSM way id, class, length and flags. Its tooltip says
  which graph file is in use. The *truth* checkbox draws the matched route in teal, the leg at the cursor thick,
  and breaks as red × (hover for the reason). With a road graph the replay also runs map matching: the
  *particles* checkbox shows the particles at the cursor (once a second, size by weight) and the top clusters as
  rings sized by their spread, labelled with weight, "off" for an off-road cluster, and the filter's state.

## Reading the summary

- **init**: how the EKF got its heading.
  - `course`: from a satellite fix with a good course.
  - `alignment`: no course, as under jamming. The heading comes from fitting the OBD + gyro track shape to the
    coarse Wi-Fi/cell fixes.
  - `never`: the fixes never pinned the heading down; the position stays anchored at the best fix, and its
    radius grows by the distance driven.
- **fixes**:
  - `accepted` / `rejected`: EKF updates; rejected fixes failed the innovation gate.
  - `anchored`: the fix arrived before the EKF started.
  - `skipped`: a repeated identical fix, or accuracy worse than 2 km.
  - `untrusted`: refused by GNSS integrity (abroad, a jump, not moving like the car, held after a gap); nothing
    used it. The `integrity` line counts them by verdict.
  - `cut`: withheld by `--cut`.
- **pre-fix error**: distance from the predicted position to each fix, measured before the update.
  - For coarse fixes, "within their accuracy" is the share that lands inside their own reported radius. It
    should be well above half if both the dead reckoning and iOS's accuracy figures are honest.
- **params**: learned speed scale (v = k_s · OBD speed), gyro bias and gyro scale.
- **cut a–b s**: error against satellite fixes with ≤ 10 m accuracy inside the outage ("truth"), next to the
  predicted 1σ. The predicted σ should be the same order as the error.

## GeoJSON

The export contains:
- the fused track as lines, by mode (`anchored`, `dr`);
- accuracy circles every 15 s;
- every fix as a point, with `status`, `hAccM` and `errorM`.

Open it in QGIS or a VS Code GeoJSON viewer. Web viewers upload the coordinates.

## Outage tests need a clean log

`--cut` scores against satellite fixes inside the cut, so it needs a drive with good GNSS. Under jamming, use the
coarse-fix consistency figures instead.
