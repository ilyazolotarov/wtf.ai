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
```

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

- **Header:**
  - *Drive*: newest first.
  - *Navigator*: the version the replay runs. *As on the phone* (default) is the one the drive was recorded with
    (the app's developer setting, in the log header); *Open loop* is what the app runs; *Road heading* and *Full correction*
    send map matching back into the navigator (MAPMATCH-SPEC §9).
  - *GPS*: what the replay gets. *As in the app* withholds your "Cut GPS" moments, as the phone did; *All of it*;
    *Cut at…* (`120:240`, several with commas); *Jammed* (Wi-Fi/cell-like fixes only, `0:inf` or a window;
    `src/nav/replay/jam.ts`); *None after the start* (pure dead reckoning once the heading is known).
  - *Compare*: a second navigator version, drawn in orange.
  - *More*: GPS lag (empty = learned on the drive, as in the app), start the session later, compass at a jammed
    start (MAPMATCH-SPEC §8.2).
- **Tracks** (side panel, each can be hidden): GPS in green (where the car really was), what the phone showed in
  purple (from the log's `nav_estimate`; older logs don't have it), the replay in blue, the compare replay in
  orange. A replay track is what the app would have shown: the map-matched position while dead-reckoning.
- **Without GPS:** every stretch without good GPS:
  - *No GPS*: no clean satellite fix for over 15 s (jamming, tunnels) while the car moved at least 30 m; scored by
    how far off each dot was when GPS came back, and whether that was inside its circle.
  - *Cut GPS (app)* and *Cut in replay*: GPS was there but withheld, so each dot is scored all through: at the end,
    at worst, and how often the real position was inside its circle (honest ≈ 68 %).
  - Click one to zoom to it and jump to its end. Code: `src/nav/replay/drive-report.ts`.
- **At the cursor:** the GPS state, and each dot's distance from the newest clean GPS fix, inside its circle or not.
- **Map:** dots with their circles and dashed distance lines to the GPS fix. *Layers* adds every GPS fix, the
  road graph, the true path (the road matched offline from clean GPS) and the replay's map-matching particles.
  Hover a fix for details; click it to jump there.
- **Timeline:** click or drag to seek; Space plays and pauses; ← and → step 5 s (Shift: 30 s).
  - *Off by*: each dot's distance from every clean GPS fix (log scale, 1–300 m); dots on a line mark moments
    outside its circle. Shaded: stretches without GPS (grey no GPS, amber Cut GPS, blue cut in the replay).
  - Speed (OBD), and GPS quality (green good, pale weak, amber Wi-Fi/cell only; red ticks are your markers).
- **Events** and **Replay details** are folded at the bottom of the side panel.
- **Links:** the URL keeps the drive, every setting and `t` (seconds), so a link reopens the same view.
- The server runs under `node --watch`, so it restarts itself when `src/nav` or the viewer code changes; reload
  the page afterwards. A server started before this change has to be stopped by hand once.

The server only listens on localhost. The basemap is the online OpenFreeMap Liberty style, so your browser
sends the map viewport to OpenFreeMap.

## Simulated city drives

Hours of driving without GPS, on a real road graph (MAPMATCH-SPEC §9.4): random routes, a car that drives them
like a driver, and the phone's sensors with measured errors (`src/nav/sim/city-drive.ts`). GPS for the first
minutes, then none; each navigator version is scored against the exact truth every second.

```bash
npm run replay:sim                                       # Chernihiv, 60 min, seeds 1–3, open vs closed loop
npm run replay:sim -- --minutes 180 --imu-hz 50 --every 30
npm run replay:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin
npm run replay:sim -- --loops open,heading,closed --gps-min 5
npm run replay:sim -- --route arterial --trace               # main roads, straight on: few turns; a line per 5 min
```

Per drive: distance, junctions, stops; per version the dot's error (median, p90, max, at the end), the share of
time more than 50 m off and the longest such stretch, the navigator's own error, and the road corrections sent. Then
the error by time without GPS (`--every` minutes). Graphs: `--graph`, else the smallest built one covering `--at`
(`gh release download maps-<date> -p <region>.graph.bin -D tools/tiles/out/release` fetches a published one).
It is optimistic: no parking, reversing, yards, unmapped roads or traffic jams.

## Routes

The app's route planner (ROUTING-SPEC, `src/nav/routing/`) on a region's road graph: one route, or the planning
time of many random ones.

```bash
npm run route -- --from 51.4939,31.2947 --to 51.5100,31.3300            # one route; --from lat,lon,headingDeg
npm run route -- --from 51.4939,31.2947 --to 50.5956,32.3873 --geojson route.geojson
npm run route -- --bench 50                                              # random routes in the region
npm run route -- --bench 50 --at 51.4939,31.2947 --radius 8             # ... within 8 km of a point
```

One route: length, time, edges, its turn instructions, how far its ends are from the points, states settled, tiles
read and planning time (`--geojson` writes the line and the maneuvers). The bench prints planning time, states and
the route's length over the straight line by distance, and the `--from`/`--to` of every route that failed.

Guidance on simulated drives (ROUTING-SPEC §8.4): false "off route" while the car follows its route without GPS,
and how soon guidance notices when it leaves one.

```bash
npm run route:sim                                        # Chernihiv, 60 min, seeds 1–3, GPS for the first 3 min
npm run route:sim -- --at 50.4501,30.5234 --graph tools/tiles/out/release/kyiv-city.graph.bin
npm run route:sim -- --gps                               # GPS all along
```

In `replay:view`, a drive with a route shows it in pink (the plan in force at the cursor; replaced plans grey and
dashed), its maneuvers, a Route panel (each plan, its planning time, "off route" count, arrival) and a "route" strip
on the timeline: pink on the route, amber leaving it, red off it, grey unsure; ticks mark plans.

## Road graph

Map matching runs on the road graph built by `tools/tiles` (`python -m tiles.cli graph chernihiv`, see its
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
npm run replay:mm -- trip.ulg --start 300 --jam 300:inf --trace 300:420 # one jammed start, second by second
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
