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
```

Keep outputs in `tools/triplog/logs/` (git-ignored). They contain coordinates.

## Outage benchmark

```bash
npm run replay:bench -- tools/triplog/logs/*.ulg                                  # current settings
npm run replay:bench -- tools/triplog/logs/*.ulg --nav '{"ekf":{"gyroNoise":0.001}}'  # try a variant
```

- **Windows:** hides GPS for 60, 120 and 240 s, starting every 30 s after the EKF starts. A window counts only
  if the hidden satellite fixes cover ≥ 80 % of it and the car drives ≥ 200 m, so only clean-GPS stretches
  score.
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

- **Header:** pick a log, enter GPS cuts (`100:240, 600:60`) and the lag, then press Replay. It replays the same
  way as the CLI, in about 1 s.
- **Open loop:** with good GPS the prediction is corrected every second, so it hugs the GPS track. Open loop
  withholds every fix once the heading is known (optionally 30–120 s later, so the speed scale and gyro bias
  can settle). From then on the right-hand map is pure OBD + gyro dead reckoning, and every later fix is scored
  against it.
- **Map:**
  - Satellite fixes are green, Wi-Fi/cell fixes amber, rejected fixes red, and fixes withheld by a cut grey.
  - The predicted track is blue: solid while dead-reckoning, dashed while anchored.
  - The current prediction shows with its accuracy circle and heading. A red dashed line joins it to the latest
    GPS fix.
  - **Side by side** splits it into two synchronized maps: GPS only on the left, prediction only on the right.
  - Hover a fix for details; click it to jump there.
- **Now panel:** GPS and prediction compared: source, age, accuracy, position gap, speed and heading. Below that,
  OBD speed, RPM, engine state and the events list (click to seek).
- **Timeline:** click or drag to seek; Space plays and pauses; ← and → step 5 s (Shift: 30 s).
  - Speed: OBD line, GPS dots.
  - Error: distance from prediction to each fix before the update, on a log scale. Red dots are fixes inside a
    cut, the honest held-out error. The blue band is the predicted accuracy.
  - Bands: GPS quality, prediction mode, engine state, events (markers in red).
- **Links:** the URL keeps the log, cuts, open loop, lag, `t` (seconds) and `split=1`, so a link reopens the
  same moment.
- The server runs under `node --watch`, so it restarts itself when `src/nav` or the viewer code changes; reload
  the page afterwards. A server started before this change has to be stopped by hand once.

The server only listens on localhost. The basemap is the online OpenFreeMap Liberty style, so your browser
sends the map viewport to OpenFreeMap.

## Road graph

Map matching runs on the road graph built by `tools/tiles` (`python -m tiles.cli graph chernihiv`, see its
README; MAPMATCH-SPEC §4–5). Tools pick the smallest `tools/tiles/out/release/*.graph.bin` with roads at the
trip's first fix, so the oblast rather than Ukraine; `--graph <file>` overrides.

```bash
npm run replay:graph -- tools/triplog/logs/*.ulg                       # graph vs clean fixes, reader timing
npm run replay:graph -- --graph tools/tiles/out/release/ukraine.graph.bin trip.ulg
npm run replay:view -- --graph tools/tiles/out/release/kyiv.graph.bin  # viewer with a given graph
```

- **`replay:graph`:** for each clean moving satellite fix (≤ 10 m, ≥ 3 m/s): the distance to the nearest road,
  the share farther than 15 m (missing roads, parking lots), and the GNSS course against the road heading.
  Then the reader's cost: open time, tiles loaded, `edgesNear` from cache and with tile loads.
- **Viewer:** the *roads* checkbox draws the graph around the trip's fixes, under the tracks: major roads thick,
  service roads and tracks dashed, arrows on one-ways (zoom ≥ 14). At zoom ≥ 15 it adds junctions, dead ends
  (orange) and region-boundary ends (red). Hover for the OSM way id, class, length and flags. Its tooltip says
  which graph file is in use.

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
