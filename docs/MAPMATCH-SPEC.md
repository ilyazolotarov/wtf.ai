# wtf.ai — Map Matching Specification

The road graph and the road-constrained particle filter (`src/nav/mapmatch/`), how they start the EKF under jamming and
feed road corrections back into it, and how the result is measured. Builds on [NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md).
Source of truth for coding agents.

## 1. Goal

Place the car on the offline road network, so that:

1. During a GNSS outage the position stays on the right road: turns correct the along-track error, the road heading
   corrects the heading.
2. Under jamming from the start of a session, the heading comes from matching the OBD + gyro track to the roads,
   sooner than alignment to coarse fixes.
3. Ambiguity is shown, not hidden: when two roads fit, both stay alive until a turn decides between them.
4. It works the same for one oblast and for the whole of Ukraine, on the JS thread, within a few ms per update.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Method | Road-constrained particle filter (PF) in pure TS. No HMM for live matching. |
| Graph | Our own graph, **one file per region** (`<region>.graph.bin`), `ukraine` included. No cross-region navigation: the active region is the whole world. |
| Large regions | The file is tiled internally (z14) and read by random access: only tiles near the live hypotheses are decoded, so cost and memory depend on the hypothesis spread, not the region size (§5). |
| Builder | Python, **pyosmium** in `tools/tiles`; Shapely for simplification. |
| OSM rules | **Soft.** One-way, turn restrictions and U-turns change branch probabilities; they never make a hypothesis impossible (§7.3). OSM tags are sometimes wrong. |
| Heading init from the map | Under jamming the PF starts with unknown heading and can start the EKF (§8). |
| Closed loop | Road heading and position go back into the EKF (§9). It is the only version: there is no open-loop setting in the app or the tools. |
| Ground truth | Offline HMM over clean satellite fixes, and roads drawn by hand in the viewer, in replay only (§10.1). |

## 3. Status

Built and driven: the graph downloads with the region, the filter runs in the app with the closed loop, trip logs
carry `nav_mapmatch`. Open: the update time on the phone (§14), drives in bigger cities (§15).

## 4. Road graph builder (`tools/tiles/tiles/graph.py`)

### 4.1 Input and filter

- Input: the region's clipped extract (`cache/extracts/<region>.osm.pbf`).
- Kept: `highway` = `motorway`, `trunk`, `primary`, `secondary`, `tertiary` (each with its `_link`), `unclassified`,
  `residential`, `living_street`, `service`, `track`, `road`.
- Dropped: `footway`, `path`, `cycleway`, `steps`, `pedestrian`, `bridleway`, `corridor`, `construction`,
  `proposed`, `platform`, `raceway`, `busway`; `area=yes`; `access` / `motor_vehicle` / `motorcar` = `no`.
- Access: the most specific of `motorcar`, `motor_vehicle`, `vehicle`, `access` wins; `no` drops the way; a value
  outside `yes`, `designated`, `permissive`, `destination`, `customers`, `official`, `unknown` sets `private`.
- Edge flags: `link`, `roundabout`, `tunnel`, `bridge`, `private`, `minor_service`
  (`service=driveway|parking_aisle|drive-through|emergency_access`), and the speed attributes (§4.3).
- Ferries are out of scope.
- Memory: read ways first, then fetch locations only for the nodes those ways reference; never a location index of
  every node. Ukraine builds within the same machine as `build-all --heap 8g` (~3 GB peak).

### 4.2 Topology

- **Nodes**: way ends, OSM nodes shared by two or more kept ways, and nodes a way visits twice. **Edges**: the way
  pieces between consecutive graph nodes, undirected with a one-way attribute. A closed way with a single graph node
  is split by an extra node (no self-loops). Degree-2 nodes where two ways meet stay as nodes.
- **Boundary nodes:** a node outside the region polygon is flagged `boundary`: ways end there without being real dead
  ends.
- **Geometry:** Douglas–Peucker at 1 m in a local metric projection, endpoints kept.

### 4.3 Edge attributes

- Length (m, of the unsimplified geometry); class (u8: motorway 0 … road 10); one-way (none, forward, backward;
  `junction=roundabout` and `highway=motorway` imply forward unless `oneway=no`; `oneway:conditional` ignored).
- **Speed attributes** for routing time (ROUTING-SPEC §4.1), every edge flagged `attributes`: speed limit (u8 km/h,
  0 untagged; `maxspeed`, else `:forward`/`:backward`; numbers, `mph`, `UA:urban` 50, `UA:rural` 90, `UA:trunk` 110,
  `UA:motorway` 130, `UA:living_street` 20, and `RU:*`); `unpaved` (surface unpaved, gravel, compacted, dirt, earth,
  ground, grass, sand, mud, …); `urban` (the edge's middle in a `place=city|town|village|hamlet` area, within 100 m of
  built-up `landuse`, or near a place point: town 1.5 km, village 600 m, hamlet 300 m); `city` (in a `place=city` area
  or within 4 km × √(population ÷ 300 000) of its point); `big_city` (the same for ≥ 500 000). Traffic lights and
  stop / give-way signs on a graph node flag the node (`signals`, `stop`); on a way within 40 m of a junction they
  flag that junction; a light farther from any junction flags its edge (`signals`: a signalled crossing).
- Names are not stored.

### 4.4 Turn restrictions

`type=restriction` relations (`restriction` or `restriction:motorcar`) with a `from` way, a `via` **node** and a `to`
way; via-way restrictions and those whose `except` includes `motorcar` are dropped. `no_*` forbids one pair; `only_*`
forbids every other exit from that from-edge at the via node. Stored per via node, tagged (not expanded).

### 4.5 File format (`<region>.graph.bin`, format 1)

Little-endian; every record a multiple of 4 bytes, so the reader uses typed-array views over a tile's bytes.

```
header      64 B   "WTFG", u16 format, u16 zoom (14), u32 x0, y0, nx, ny, u32 nodes, edges,
                   u32 directory offset (64), u32 data offset, char[16] OSM date, u32 build time (unix s),
                   u32 features (1: speed attributes)
directory          u32[nx·ny + 1]: tile i = (y − y0)·nx + (x − x0) spans [off[i], off[i+1]) after the data offset
tiles              per non-empty tile, in tile order:
  counts    24 B   u32 nodes, incidence, edges, vertices, restrictions, spatial
  nodes     16 B   i32 lon, lat (1e-6°); u32 first incidence; u16 incidence count;
                   u16 flags (1 boundary, 2 dead end, 4 traffic lights, 8 stop / give way)
  incidence  8 B   u32 tile, u16 edge index, u16 end (0: the edge starts at this node, 1: it ends here)
  edges     28 B   u16 from-node (local); u8 class; u8 one-way (0 none, 1 forward, 2 backward); u16 flags (1 link,
                   2 roundabout, 4 tunnel, 8 bridge, 16 private, 32 minor service, 64 unpaved, 128 urban, 256 traffic
                   light along it, 512 attributes, 1024 city, 2048 big city); u16 vertex count; u32 to-node tile,
                   u16 to-node index, u8 speed limit (km/h, 0 untagged), u8 0; f32 length (m); u32 first vertex;
                   u32 OSM way id
  vertices   8 B   i32 lon, lat (1e-6°); an edge's first and last vertex are its from- and to-node
  restr.    20 B   u16 via node (local); u8 kind (1 no, 2 only); u8 0; u32 from-edge tile, u16 index, u16 0;
                   u32 to-edge tile, u16 index, u16 0
  spatial    8 B   u32 tile, u16 edge index, u16 0
```

- **Ids:** a reference is (tile, local index); `GraphId = tile · 65536 + index`. The builder fails if a tile has more
  than 65 535 nodes or edges.
- **Home tile:** an edge lives in the tile of its first node; a node in the tile that contains it. **Incidence:**
  each node lists every edge touching it, wherever the edge lives. **Spatial:** every edge whose simplified geometry
  crosses the tile.
- The speed attributes went into spare flag bits and padding so the format stays 1: older apps read newer files,
  newer apps older files (no `attributes` flag: routing falls back to class speeds).
- No compression (a JS inflater on every tile load wasn't worth 1.85×). `tiles graph-check <file>` validates a file.
- Sizes (OSM 2026-10): an oblast ~15 MB, 130 k edges, 6 s to build; `ukraine` 452 MB, 4.3 M edges, 206 k tiles, the
  median tile 0.8 kB, the largest 216 kB.

### 4.6 Release

`build-all` and `build-region` write `<region>.graph.bin` next to `<region>.pmtiles`; `tiles graph [regions]` builds
only the graphs. `index.json` carries a per-region `graph` entry `{ asset, size, md5, sha256 }`; a region without one
is display-only. `tools/tiles/tests/test_graph.py` covers the tag rules, splitting, simplification, flags,
restrictions, spatial lists, the round trip and the speed attributes; the TS reader's fixture
(`src/nav/mapmatch/__fixtures__/net.graph.bin`) comes from the same builder (`UPDATE_FIXTURES=1 python -m pytest`).

## 5. Reader (`src/nav/mapmatch/graph/`)

- Pure TS. The file is reached through `ByteSource { size; read(offset, length): Uint8Array }` (synchronous): Node
  `fs.readSync` (`tools/replay/graph-file.ts`), the device an `expo-file-system` `FileHandle`
  (`src/services/offline-map/road-graph-file.ts`), tests a buffer; `MemoryRoadGraph` holds a small graph in memory
  (the guide's lessons).
- **`RoadGraph`** (all the PF and the router see; `TiledRoadGraph` implements it): `edgesNear(e, n, radius)` nearest
  first with distance, closest point, distance along and heading there; `edge(id)` (class, one-way, flags, way id,
  geometry in degrees and ENU with cumulative distance); `exits(via, dir)` (every way out of the node reached along
  `via`, each with its direction, turn angle clockwise positive, `againstOneway` / `restricted` / `uTurn`: the reader
  only reports, the PF applies the soft factors); `node(id)`.
- **Frame:** decoded geometry is in the navigator's local ENU frame; `setFrame` on re-anchoring drops the decoded
  edges, the tile bytes stay cached.
- **Working set:** after each resample and at least every 50 m, the tiles inside circles around each cluster
  (radius 3 × spread + 300 m) plus the init area are loaded; decoded tiles sit in an LRU of 128 (`pin` keeps some);
  a particle stepping into an unloaded tile loads it synchronously. The router has its own reader with 2048 tiles.
- Measured in Node: open 0.1 ms (oblast), 0.8 ms (Ukraine: the 1.8 MB directory); tile load 0.07–0.3 ms;
  `edgesNear(50 m)` from cache 40–90 µs. The oblast and Ukraine files give identical matches.

## 6. Navigator interface

### 6.1 Odometry output (navigator → PF, `src/nav/odometry/odometry-output.ts`)

`Navigator.subscribeOdometry(listener)` hands out each integration step's `Δs` and `Δψ`, summed into chunks of 2 m
or 0.2 s (a change of source or direction closes one early). Each chunk: `t0Us`, `t1Us`; `dsM` (≥ 0), `dpsiRad`
(clockwise positive) and their variances; cumulative `distanceM` and unwrapped `turnRad`; flags `stopped`,
`yawUnknown` (gyro invalid while moving), `speedUnknown` (OBD stale), `reverse` (reverse gear from CAN); `source`:

- `ekf` (mode `dr`): exactly the EKF's own motion (`Δs = max(0, v)·dt`, `Δψ = −k_ω (ω − b_ω) dt`, 0 while holding at
  standstill);
- `relative` (before the EKF starts): OBD × the stored `k_s`, the gyro minus the bias learned at stops. This is what
  makes §8 possible.

Variances: `dsVar = (σ_ks/k_s · Δs)² + (0.1 m/s · T)²`; `dpsiVar` = gyro white noise (or the handling noise while
invalid) + `(σ_bω·T)²` + `(σ_kω·Δψ)²`. No raw sensor data crosses this interface; Stage 2/3 sources feed the same
output.

### 6.2 PF output (PF → navigator → map)

`NavEstimate.mapMatch`: `state` (`off` | `init` | `tracking` | `multimodal` | `offroad`), up to 5 `clusters` by weight
(`{ weight, lat, lon, headingRad, headingSpreadRad, spreadM, covariance, edge, road, particles }`), `particles`,
`updateMs`. How the map draws it: §11. Integrity uses all clusters as hypotheses after a gap (NAVIGATOR-SPEC §8).

## 7. Particle filter (`particle-filter.ts`)

Structure of arrays over typed arrays, for Hermes. The values below are `DEFAULT_MAP_MATCH`; §13 lists them.

### 7.1 Particle state

- **On-road:** `edgeId`, `offsetM`, `dir` (±1 along the geometry), `dks` (distance-scale perturbation), `roadTurn`
  (cumulative road-heading change along the particle's path), `anchorTurn` (`roadTurn` at the last comparison),
  `weight`. **Off-road:** `e`, `n`, `psi`, `dks`, `weight`.

### 7.2 Initialization

- **Known heading** (EKF running; parked pose; placing): candidate edges within 3σ of the position, travel
  directions within 3σ_ψ + 10° of the heading, particles spread by the position likelihood; the off-road share
  (5 %) around the position. **Parked off the roads** (the pose's `offRoad`): the off-road share is 60 %, so the
  start is `offroad` at the spot until the car drives onto a road (with 5 % the roads within 3σ took the weight and
  the dot started on the heaviest one, 84 m from the lot).
- **Unknown heading** (navigator `anchored`, §8): all roads within the anchor radius (3σ of the anchor fix plus the
  distance driven, at least 20 m; for a Wi-Fi/cell fix the larger of its claim and 3 × min(claim, 150 m)), placed
  evenly along the parts inside the circle, once in each direction (against a one-way at the soft factor); off-road
  5 % anywhere in the circle. Count = road length × 2 ÷ 10 m, clamped to [500, 4000]. Anchor radius over 1 km: wait.
- **Re-init:** after `offroad` lasting 300 m; when a fix the EKF accepted is more than 5σ + 3 m from every particle
  (the filter lost the car: restart around the EKF); after a lost turn (§7.4); after a navigator reset (heading
  unknown); when the region or graph changes.

### 7.3 Propagation (per odometry chunk; frozen at standstill)

- **On-road:** advance `Δs · (1 + dks)` plus noise (`alongNoise` 0.03).
- **At a node,** choose the next edge among the exits with probability ∝ uniform × soft factors: against a one-way
  0.02; restricted turn 0.05; U-turn at a node that isn't a dead end 0.01; `private` 0.3, `service` 0.5. The
  measured turn isn't used to pick the branch (it isn't complete when the particle reaches the node); weighting
  prunes the wrong branches over the next metres. Dead end: the particle turns around. Boundary node: it becomes
  off-road. Tried, not kept: a preference for the bigger road (wrong road 10 → 14 % on the jammed corpus; where turns
  leave two roads open the prior picks the wrong one).
- **U-turn on an edge:** when the measured turn over the last 20 m exceeds 135°, a share (0.2) of the particles
  reverses `dir`.
- **Off-road:** unicycle step with `Δs·(1 + dks)` and `Δψ`, heading noise 0.01 rad/√m; with 2 % probability per step
  a particle within 5 m of an edge heading within 20° of it snaps onto it.
- **`yawUnknown` chunks:** junction choice stays uniform and the next relative-heading weight is skipped.
- **`reverse` chunks** (reverse gear): the particle moves `Δs` the other way along its road, still facing as it did;
  at a node it takes an exit behind it, one-ways not counted; off-road, the unicycle steps backwards. No U-turn flips.

### 7.4 Weighting

Every 10 m of travel, plus each accepted fix. All terms are log-likelihoods, summed.

- **Relative heading (main term):** the car's measured turn against each particle's road turn between two
  *comparison moments*: when the car drives straight (turned < 8° over the last 10 m), so a whole turn lies inside
  the interval for the car and the road (mid-turn the car turns gradually while a polyline turns at a vertex, and a
  sliding window put the filter off-road at every turn entry); also when the car halts, and after 20 m without a
  straight moment (`maxCompareM`: a curve, or manoeuvring in a yard). Gaussian with σ² = gyro variance since the last
  comparison + (5°)² + (10 % of the turn)², 30 % for a forced comparison; skipped when the gyro was invalid. It uses
  heading changes, so gyro drift and absolute heading error don't matter; particles still before the vertex when
  the car has finished turning are pruned, which corrects the along-track error.
  - **A turn the cloud missed** (`lostTurnRad`): at a straight moment after a turn of ≥ 60° driven at ≥ 20 km/h, if
    on-road particles holding < 5 % of the weight turned within 30° of the gyro, the filter lost the car along its
    road, and the navigator starts it again around the EKF over twice its position σ (the EKF's position along the
    road came from those particles). Normalisation would otherwise hand the weight to whichever wrong hypothesis was
    least wrong.
- **Absolute heading (weak, `dr` mode, straight moments only):** EKF ψ versus the particle's travel heading, σ_ψ
  widened ×3, scaled by 0.3. It mostly separates the two directions on a straight road.
- **EKF position (weak, `dr` mode):** distance to the EKF position, σ = max(2 × EKF σ, 10 m), scaled by 0.3. Without
  it a hypothesis on a road 50 m from a 6 m-accurate EKF could win; off it, drives jammed from the start lock the
  filter off-road through Wi-Fi fixes. Kept at 0.3 (0.1 and 0 scored worse with the loop closed).
- **GNSS position** (fixes the navigator accepted): satellite fixes count only 10 m of travel apart (correlated
  errors; at a standstill repeated fixes made off-road particles sitting on a biased fix win). On-road particles: the
  first 3 m cost nothing (lane offset), then σ = `h_acc/1.5` ⊕ 2 m; off-road: distance as is. Coarse fixes: σ =
  `h_acc`, 25 m of travel apart, with a floor of 0.15 on their likelihood (`coarseOutlier`: within the claim about 6
  times in 7 against the drawn truth, so a wild one costs a hypothesis at most ×6 and three that agree settle a
  wrong road). Compared at fix time, shifted back along the travel direction by GNSS lag × speed.
- **Off-road:** a penalty (×0.5) per 10 m instead of the relative-heading term, its exponent growing linearly from
  ×1 at 20 km/h to ×12 at 40 km/h and above (`offRoadSpeed`): off-road is for yards and lanes driven at walking pace,
  and at road speed the filter keeps to the roads unless a turn no road explains says otherwise. Not while the
  heading is unknown (state `init`): the off-road particles would fall below the stale threshold at every weighting
  and each resampling would re-seed the region. A dot a little late in a yard is far less bothersome than one
  driving through buildings beside the road.

### 7.5 Resampling and particle count

- Systematic resampling when ESS < N/2, and when the off-road particles hold less than 10⁻⁵ of the weight (their
  penalty accumulates on a road and, unresampled, they drift off it; when the car then leaves the road none is near).
- Off-road share kept ≥ 5 %, except **at road speed** (≥ 40 km/h): no off-road particles are kept, and every
  off-road particle is put back on the nearest aligned road within 90 m (`onRoadRecoverProjectM`; 45 m left a cloud
  that had left the map on a road it lacks off the roads). The penalty alone can't do it: it moves weight from
  off-road to on-road particles, and with the whole cloud past 15 m from every road there are none to move it to.
- On-road share kept ≥ 10 %: off-road particles are projected onto the nearest edge within 15 m whose direction fits
  within 30°, so on-road hypotheses stay where the car will come back onto a road.
- 2 % of particles re-injected around the clusters (nearby edges, both directions when the cluster is new). `dks`
  jittered (0.002) at resampling.
- **Count:** 500 (`particles`); more only for an unknown-heading start, shrinking to 500 at the first resampling
  after the filter first tracks.
- **Re-seeding while the heading is unknown:** until the first `tracking`, 5 % of the particles are re-seeded at each
  resampling on all roads of the navigator's current anchor circle with a neutral turn history, so a true road
  pruned early can come back.
- Never let the truth vanish: re-injection plus the soft rules are what the metrics' truth survival relies on.

### 7.6 Clusters and state

- **Greedy clustering** in weight order: a cluster is the particles within 30 m of the seed with travel heading
  within 45° (opposite directions on one road are different hypotheses); stops after 64 clusters or 1 − 10⁻⁴ of the
  weight. Values: weight, weighted mean position and covariance, circular-mean heading and spread, spread (weighted
  RMS distance), the edge holding most of its on-road weight (null: all off-road), and `road` (§11).
- **States:** `tracking` (top cluster ≥ 0.9 of the weight, spread ≤ 25 m); `multimodal` otherwise while on-road;
  `offroad` (off-road particles hold > 50 %); `init` (unknown-heading start until the first `tracking`); `off` (no
  graph).

### 7.7 Integration

`Navigator.setRoadGraph(graph, config)` starts the filter with the heading unknown at the first fix (§8), or around the
EKF when that starts otherwise and the filter doesn't already agree with it; again when a fix says it is lost, after
300 m off-road, after a lost turn. It feeds the odometry (flushed at each fix, so the filter is at the fix time), the
EKF pose and accepted fixes, and moves the graph's frame with the navigator's. Tests: `__tests__/particle-filter.test.ts`
on the fixture graph (a cut before a junction follows the branch the car turned onto; a turn into open country hands
over to off-road; reversing 36 m ends 0.4 m from the truth; a jammed start at a dead end starts the EKF within 400 m;
mid-road both directions stay alive and no start; the compass right and turned 180°).

## 8. Heading initialization from the map (jammed start)

Under jamming the navigator sits in `anchored` (position known to ±hundreds of metres, heading unknown) until a
course or alignment starts the EKF. The PF can resolve both faster: it only needs relative odometry.

- **Start:** in `anchored`, at the first fix with a graph and an anchor radius ≤ 1 km, with unknown heading (§7.2).
  The filter runs from the first fix even when GNSS is clean: a course start then usually finds it already tracking.
- **Inputs:** `relative` odometry (§6.1), the relative-heading weight, every fix (coarse ones with the `coarseOutlier`
  floor), the off-road penalty, re-seeding on the anchor's roads. No absolute heading. The anchor circle follows the
  navigator's anchor after each fix.
- **EKF start** (`initialization.method` = `map`, note `nav init map`), checked every 10 m:
  - the heading settled over 100 m: the filter is `tracking`, or one travel direction (particles within 45° of the
    circular mean) holds ≥ 0.9 of the weight with heading spread ≤ 10° and position spread ≤ 150 m (one direction
    along one road, before the turn that will fix the position along it);
  - the car drives straight (< 8° over 10 m) and ≥ 0.9 of the weight is where the road is straight (within 5°) over
    ±(15 m + the position spread): a polyline bends at a vertex, the car gradually (starts just past a 9° bend were
    9–10° off);
  - pose: the tracked cluster or that direction's particles; position = their mean, σ = max(spread, 10 m); ψ = the
    circular mean, σ_ψ = hypot(max(heading spread, 3°), 0.1°/m × position spread).
- **After the start** the filter carries on (it holds the turns driven so far). An EKF started by a course, alignment
  or parked pose keeps the filter only if it is `tracking` with its top cluster within 3σ + 30 m and 3σ_ψ + 30° of
  the EKF; otherwise the filter restarts around the EKF. Five satellite fixes failing the gate reset the navigator to
  `anchored` and the filter restarts there with the heading unknown.
- **Ambiguity:** on a straight road both directions stay alive until a turn, a dead end or the coarse fixes separate
  them; in a grid, all junctions with the same turn sequence stay alive. Unimodality is the rule; no "needs N turns".
- **The pull-out turn is weighed like any other:** leaving a parking space turns the car 50–120° within the first
  10–25 m; it is often a mapped turn, and it is what lets the roads overrule a wrong alias or compass. Skipping the
  first 30 m gave more map starts and more wrong ones.
- Measured on simulated jams from the clean drives: the map starts first in most sessions, about 0.4 km in,
  heading within 2.6°; every start over 10° off is an alignment start the map didn't beat (alignment is
  overconfident on some drives, NAVIGATOR-SPEC §13).

### 8.2 Compass at a jammed start (replay only; NAVIGATOR-SPEC §7.6)

While the heading is unknown, at each straight moment each particle's compass factor
`inlier · N(travel direction − compass; 25°) + (1 − inlier)`, `inlier` 0.85, replaces the one already in its weight
(not added up: the compass error is a bias that lasts the drive, and stacking it left the true direction ~1/280 of the
weight); bounded to 6.7:1 between the best and worst directions. Only from a calibration confirmed on the drive that
kept it. A map-start guard requires the start's direction (±45°) to hold ≥ 0.5 of the weight with the compass divided
back out. Measured with a calibration pooled from other drives: more and sooner map starts with the right compass,
none wrong; turned 90° or 180°, three wrong starts in 180 sessions, which is why the app stays in shadow.

## 9. Closed loop (PF → EKF)

- **When:** state `tracking`, navigator in `dr`, every 25 m of travel. Past 500 m without a turn, also when the
  hypotheses travelling the top one's way (within 45°) hold 0.9 together, taken as one with a covariance spanning
  them (`oneWayAlong`): on a long road the filter knows the road and direction for kilometres before it knows where
  along it, and the EKF otherwise took no road update for 20 km.
- **Road heading:** σ = 4° (⊕ the filter's heading spread), only where the road is straight within 3° over ±15 m and
  not within 20 m of a node, the filter `tracking` (≥ 0.9 of the weight on such road) and the car driving straight.
  Sent also while GNSS is trusted: it is the fix for the ~2° heading error at outage start. 2° made the EKF
  overconfident: updates 25 m apart on one road share its geometry error and the lane offset.
- **Position** (`roadPositionUpdate`, only while GNSS isn't trusted: the PF already weighs the same fixes): the
  dominant cluster's mean, in `tracking` on a road, at most every 200 m, with its weighted covariance floored at 12 m
  along the road and 5 m across (25 m with 5/3 m floors collapsed σ to 2–3 m against errors of ~10 m), as a full 2×2
  measurement (`DrEkf.updatePositionCovariance`). Along the road the floor grows by 1 % of the distance since the car
  last turned (≥ 30° within 50 m), and along the road it is sent once per turn (after that the filter has the
  position along the road from the same odometry as the EKF, and repeated updates shrank the EKF's along σ to metres
  while 200 m off, so a T-junction had no particle near it); across the road it is sent every time. "Trusted" here: a
  satellite fix accepted by the EKF in the last 3 s.
- Both use the EKF χ² gate (16). A rejection is an app note, not a reset.
- **Order:** road heading, then position, then the filter's EKF-position term (§7.4), which feeds the EKF back into
  the filter.
- The trip log header says `nav_mapmatch_loop: closed` (older logs may say `open` or `heading`: replay runs the closed
  loop all the same), and at engine off the note `mm loop closed: road heading N (k refused), road position M (k
  refused)`.
- Measured on real outages (`replay:bench --mm`): 240 s max error median 59 → 17 m, p90 124 → 20 m against the open
  loop, the truth inside the drawn circle 61–65 % of the time; on simulated 3 h city drives without GPS (§9.4) the
  error stops growing (median 4–6 m, worst ~50 m), where the open loop got lost on most runs.
- **Tried, not kept:** a map-free twin EKF (`mapMatchTwin`, off) as a position prior for the filter: it drifts like
  the open loop and brings its failure back; a looser pull to the EKF (σ floored or widened with the distance since
  the last fix): the dot hopped along the road and real drives got worse. The tight pull is what keeps the filter on
  the road the car is on.

### 9.4 Simulated city drives (`npm run replay:sim`, `npm run sim:drives`)

`src/nav/sim/city-drive.ts` drives a random route or a planned one on a real road graph for hours: drivable roads
only, cruise speed by road class, slowing for turns, stopping at a quarter of the junctions, pure pursuit on a line
1.5–3.5 m right of the centre line with a slow lateral wander for map error; OBD × 0.981 − 0.23 km/h rounded, 0
below 2.5 km/h; GNSS errors σ 2.5 m correlated over 30 s; the measured phone and driver (NAVIGATOR-SPEC §9.8). The
truth is exact, scored every second. Optimistic: no parking, reversing, yards, unmapped roads, traffic jams, tunnels
or handling; real long drives with Cut GPS are the check. Long roads with few turns showed the speed calibration's
limit (0.4 % low after 15 min of town GNSS, 110–170 m behind after an hour of highway); the growing along-road floor
(§9) is what lets the next turn pick the right junction there.

## 10. Replay, ground truth and metrics

### 10.1 Ground truth (`src/nav/replay/truth-match.ts`, `drawn-truth.ts`)

- **HMM** (Viterbi) over satellite fixes ≤ 10 m: states the 8 nearest edges within 30 m in both directions;
  emission N(distance; 5 m) × N(course − direction; 20°) when moving ≥ 3 m/s; transition exp(−(|route − OBD
  distance| + penalty) / β), β = 5 m + 5 % of the OBD distance, routes by Dijkstra bounded to 1.5 × OBD + 50 m;
  penalties (m) against a one-way 200, restricted turn 100, U-turn 100 (free at a dead end): soft, so a wrong tag
  can't break the truth. Breaks: `no candidates` (off the graph), `gap` (> 30 s between clean fixes), `no route`.
  `isSameRoad`: the same edge, or one sharing a node with the truth edge while the truth is within 15 m of it.
- **Drawn by hand** (the viewer's *Draw the truth*) where there is no clean fix, which is most jammed drives: the
  roads clicked, joined by the shortest way along the roads ignoring one-ways and restrictions; clicks more than 12 m
  from the graph, two in a row or at a drive's end, or a road route over 3× the straight line and 100 m longer
  (`isDetour`), are straight lines. The car's place on the path every second comes from the odometer (OBD, or the
  CAN wheels on a log recorded with CAN primary), pinned at the log's ends and at clean fixes; the timing's doubt
  grows by 3 % of the odometer distance to the nearest pin. The score is *off the drawn road*: the dot's distance to
  the path within 300 m along it of the timed position, plus twice the doubt.

### 10.2 Metrics

| Metric | Definition |
| --- | --- |
| Wrong-road rate | Share of moving time the dominant cluster is not on the truth road |
| Truth survival | Share of moving time at least one particle is on the truth road; target 100 % outside HMM breaks. The only metric that counts state `init` |
| Re-lock time | From entering `multimodal` to `tracking` on the truth road |
| Position error | Dominant cluster versus held-out fixes in the `replay:bench` windows, next to the EKF |
| Heading init | Distance to the EKF start, heading and position error at the start, ÷ the σ it started with (§8) |
| Update time | PF update p50 / p99 in Node; on the phone from the `mm timing` note and `nav_mapmatch` |
| Inside circle | Share of held-out fixes within the drawn circle (1.5 σ); honest ≈ 68 % |

**Every one of these is one filter seed.** The particle filter is chaotic: a change that only shifts the random
stream sends a 45-minute drive down a different path, and a single replay of a single drive measures mostly luck.
Report a sweep (`--seeds N`), per seed, not a mean: eight seeds for a metric aimed at one failure, three to ten for
the corpus.

**And on every drive, not only the one a change is for.** `npm run replay:regress -- --against <saved run>` replays
each drive through the app as the viewer does, with several seeds, from three starts (the parked chain, the chain with
each drawn drive parked where its drawing starts, and cold), and lists every drive that got worse against its drawn
truth, else its clean fixes, else its Wi-Fi fixes, plus the dot off the roads at speed and its jumps. An average hides
one drive gone from 15 to 490 m off, and most jammed drives have no satellite fix at all, so every metric scored
against GPS skips exactly them.

**Incidents** (`src/nav/replay/incidents.ts`): what a driver would see go wrong, every 0.2 s, the dot as drawn
against the truth:

| Incident | When (major) |
| --- | --- |
| lost | > 100 m from the car (+ twice the timing doubt) for ≥ 20 s |
| wrong-way | arrow > 120° off the car's heading for ≥ 0.6 s |
| wrong-road | > 30 m from every part of the path near the car for ≥ 5 s, or > 60 m |
| far | on the path but > 50 m (+ twice the doubt) along it from the car, and as far in a straight line |
| jump | a step ≥ 30 m longer than the car drove in it |
| backwards | on the path, ≥ 15 m back along it within 1.5 s while the car goes forward |

A replay that judged nothing fails rather than passing clean; a drawing the odometer can't time gets no count;
seconds where a satellite fix the navigator took is > 40 m from the drawn roads aren't judged, and `replay:regress`
lists them to redraw. `replay:incidents` lists them for drawn and simulated drives (`sim:drives`: Kyiv trips planned by
the router, GPS all along, lost or spoofed from 200 s, or jammed as the real drives are; `--phone-only` judges phone-only
mode by time since the start). When a driver sees something no incident reports, fix the detector first and show it
fires on that log, then the navigator.

### 10.3 Tooling (`tools/replay/README.md`)

> **A replay runs what the app runs.** `DEFAULT_MAP_MATCH` and `DEFAULT_NAV_CONFIG` are the app's; `--mm '<json>'`
> and `--nav '<json>'` override one for an experiment. A setting the app ships other than its default would let the
> replay drift from the phone (a dot that drove through a field on the phone while the replay of the same log never
> left the road). Change the default instead.

`replay:mm` (metrics per drive, `--trace from:to` per second, `--cut`, `--start`, `--jam start:len|inf`),
`replay:bench --mm` and `--jam-start`, `replay:truth`, `replay:graph`, `replay:places`, `replay:crossings`,
`replay:junction`, `replay:offroad`, `replay:regress`, `replay:incidents`, the viewer's roads, truth and particles
layers. `--jam` (`src/nav/replay/jam.ts`) turns satellite fixes into coarse ones: no speed or course, an
Ornstein–Uhlenbeck error (σ 45 m per axis, correlation 120 s), reported `h_acc` 65 m, one every 5–10 s, 30 %
repeating; `MEASURED_JAM_ARRIVALS` reproduces the real jams' Wi-Fi bursts and cell fixes.

## 11. App

- **Downloads** (`src/services/offline-map/map-packs.ts`): the graph downloads with the region's tiles and search
  index, size and MD5 checked, into `Documents/maps/`.
- **NavigatorService** opens the active region's graph (`road-graph-file.ts`) and passes it to the navigator; a change
  of region or graph version restarts the PF (`mm graph <region>` / `mm graph none`); without a graph, `mapMatch` is
  absent.
- **The dot** (`src/nav/position/puck.ts`, shared with replay): the dominant hypothesis while the position source is
  `dr` (no recent trusted satellite fix), radius max(spread, 5 m); with GNSS the EKF is the dot. Alternatives
  (weight ≥ 0.05) are drawn in state `multimodal`. Its rules:
  - **The route tips the direction:** with a route active, a cluster within 30 m of it (and of its first segment
    carried 300 m back) travelling against it counts 4 times less when the dot is chosen; the heaviest cluster then
    becomes an alternative. Only the choice: the filter's weights never see the route (as a per-particle factor it
    thinned the hypotheses until a wrong one reached 0.9). Not applied where the route passes both ways within 30 m.
  - **The car's own heading tips it too:** a cluster travelling more than 90° off the navigator's heading, while that
    is sure to 30°, counts 100 times less. Through a turn the filter compares turns only at the next straight moment,
    so mid-turn at a T-junction the particles that turned left and right weigh about the same; the gyro knows which
    way the car turned.
  - **On a road while it drives:** an off-road dominant hypothesis at ≥ 15 km/h is drawn at the nearest point of a
    road it could be driving along (within 80 m, heading within 60°, not against a one-way; `clusters[].road`),
    and the road it was drawn on stays while at most 20 m farther than the nearest. Nobody parks at 15 km/h. The
    filter keeps its off-road hypothesis; only the drawing changes.
  - **Continuity:** the dot stays with the hypothesis it was drawn on (the one within 15 m of where the last dot has
    driven to) while that keeps half the leader's weight.
  - **Steady along its road** (`steadyDot`): while the hypothesis drawn continues the last dot's road (heading within
    45°, within 80 m of where the last dot has driven to), the dot moves toward it across the road at once but along
    it at most 1 m/s back and 8 m/s ahead, never more than 15 m from it: a hypothesis' position along its road
    wanders with each resampling.
  - **Glides** (`slideMps` 25 m/s): across its road, onto another road or round a turn, within 80 m, the dot goes to
    the hypothesis no faster than that; the filter's corrections come 30–80 m at once.
  - **Published again at the same moment** (a fix came, the navigator's clock didn't move) the dot stays where it was.
  - **At the spot it parked in off the roads** (`parkedOffRoad`: started from such a pose, not 20 m driven since,
    state `offroad`) the EKF is the dot.
- **Trip log:** `nav_mapmatch` with each `nav_estimate` (TRIP-LOGGER-SPEC §6.3): state, particle and cluster count,
  the top 3 clusters, the graph version, and every filter update since the previous record (count, total, slowest).
  Notes `mm graph …`, `mm <state>` on each change except flips between `tracking` and `multimodal`, `nav mode dr
  (map)`, and at engine off `mm timing: <n> updates, p50 … ms, p99 … ms, max … ms, … % of the time, <k> over 5 ms; <s>
  starts, slowest … ms` (`update-timing.ts`; starts are kept apart from updates: a start lays particles on every road
  around the car and reads those roads from storage). `tools/triplog` sums them (`summary()["map_match_timing"]`).
- **Developer → "Map matching on the map (particles)"** draws the 200 heaviest particles (size by weight, amber
  off-road) and each hypothesis as a dashed ring of its spread labelled with its weight: the navigator's state
  ~300 ms back.
- **Parked pose:** position + heading only; edge ids change between graph versions, the PF snaps onto the graph at
  start.

## 13. Values (`DEFAULT_MAP_MATCH`)

| Value | Default | Where |
| --- | --- | --- |
| `particles` / `maxParticles` | 500 / 4000; unknown heading 1 per 10 m of road and direction | §7.2, §7.5 |
| Odometry chunk | 2 m or 0.2 s | §6.1 |
| Weight interval | 10 m | §7.4 |
| Straight moment / forced comparison | < 8° over 10 m / after 20 m, or at a halt | §7.4 |
| σ_road, turn tolerance | 5°, 10 % of the turn (30 % forced) | §7.4 |
| Lane dead zone / lane σ | 3 m / 2 m | §7.4 |
| Fix spacing (satellite / coarse) | 10 m / 25 m | §7.4 |
| Coarse-fix σ / likelihood floor | `h_acc` × 1 / 0.15 | §7.4 |
| Absolute heading | EKF σ_ψ × 3, scale 0.3 | §7.4 |
| EKF position prior | σ = max(2σ, 10 m), scale 0.3 | §7.4 |
| Off-road penalty | × 0.5 per 10 m, exponent × 1 → 12 from 20 to 40 km/h (not in `init`) | §7.4 |
| Lost turn | ≥ 60°, on-road match within 30° holding < 5 %, at ≥ 20 km/h; restart over 2 × EKF σ | §7.4 |
| On-road floor while off-road | 10 %, projection ≤ 15 m, ≤ 30° | §7.5 |
| At road speed (≥ 40 km/h) | no off-road particles; all projected, ≤ 90 m | §7.5 |
| `dks` prior / jitter | 0.02 / 0.002 | §7.5 |
| Off-road share / parked off-road / re-injection | 5 % / 60 % / 2 % | §7.2, §7.5 |
| Stale off-road resampling | off-road weight < 10⁻⁵ | §7.5 |
| Re-seeding while the heading is unknown | 5 % per resampling | §7.5 |
| Soft-rule factors | one-way 0.02, restricted 0.05, U-turn 0.01, private 0.3, service 0.5 | §7.3 |
| U-turn on an edge | > 135° over 20 m, share 0.2 | §7.3 |
| Cluster radius / heading / max | 30 m / 45° / 64 | §7.6 |
| `tracking` threshold | top ≥ 0.9, spread ≤ 25 m | §7.6 |
| Map heading init | settled over 100 m (`tracking`, or one direction ≥ 0.9 with ≤ 10° / ≤ 150 m spread); straight car and road (±15 m + spread, 5°); anchor radius ≤ 1 km | §8 |
| Map start σ | position max(spread, 10 m); heading hypot(max(spread, 3°), 0.1°/m × spread) | §8 |
| Keep the filter at an EKF start | top cluster within 3σ + 30 m and 3σ_ψ + 30° | §8 |
| Compass | inlier 0.85, σ 25°; replay only | §8.2 |
| Road heading | every 25 m, σ 4° | §9 |
| Road position | every 200 m; floors 12 m along, 5 m across; along floor + 1 % of the distance since the last turn | §9 |
| Tile cache / working-set margin | 128 tiles / 300 m | §5 |

## 14. Verification targets

1. `replay:regress` after any change: no drive worse on parked and drawn starts over several seeds; incidents on the
   simulated drives (`replay:incidents --against`) not up.
2. `replay:bench --mm`: the truth inside the drawn circle 60–85 % pooled; no drive below 40 %.
3. Jammed start: the EKF starts from the map before alignment on the real jammed drives and on `--jam-start`, with no
   map start > 10° off.
4. Ukraine graph: opening it reads only the header and directory; tracking a drive decodes about as many tiles as
   the oblast graph.
5. PF update < 5 ms p99 on the phone at 500 particles. **Not met** on the test iPhone: ~8 ms median per update (p99
   ~40 ms, the slowest 143 ms; ~25 ms with 2 000 particles at an unknown-heading start), about 10× Node. Smooth at
   2–3 updates a second; spikes can drop frames. Next: profile one drive's updates on the phone (weighting vs
   resampling vs tile reads) before cutting particles.
6. Lint, typecheck, Jest and `tools/tiles` pytest green.

## 15. Open items

1. Update time on the phone (§14, item 5).
2. Drives in bigger cities with parallel roads and dense grids; a turn-sequence alias in a grid can start on the
   wrong road until fixes or further turns separate the junctions.
3. Low-speed manoeuvring decides road vs off-road 20–30 m late; reversing on OBD-only cars rotates the particles in
   place.
4. Flip-flopping jammed starts: a filter alternating between `tracking` and `multimodal` never holds 100 m.
5. Via-way restrictions, ferries and street names are not in the graph.
6. **Tried, not kept** (don't bring back without a road case): a penalty for off-road particles crossing a road away
   from a junction (`road-crossing.ts`; crushed particles fall below the stale threshold and the resampling reshuffles
   the hypotheses, and it cost 10× the update time); road class by speed (most city streets are untagged 50 km/h
   roads; only "faster than this class ever sees" could work); weighing the EKF position along the road once with
   clusters reaching 150 m (broke the drives with no satellite fix at all); moving particles to the junction a sharp
   turn names (fires on the wrong junction elsewhere); a wider reach across to a road (the error was along one);
   restarting the filter when the EKF refuses its road position twice; forbidding off-road from 10–20 km/h (lost the
   city simulations: off-road particles are the way back from a wrong road); comparing turns mid-turn sooner
   (`maxCompareM` 10–15 m: 19 real drives worse); the route as a factor in the particle weights (§11).
