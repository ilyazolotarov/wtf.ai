# wtf.ai — Map Matching Specification

Status: draft v1 (2026-10-04). Implements SPEC.md Phase 5 (map matching) and the road-graph item of Phase 0.
Details SPEC §3.7 (particle filter) and §3.8 item 3 (road graph). Builds on the Stage 1 navigator
([NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md)). Source of truth for coding agents.

## 1. Goal

Place the car on the offline road network, so that:

1. During a GNSS outage the position stays on the right road. Turns correct the ±2–3 % along-track error, and the
   road heading corrects the heading (NAVIGATOR-SPEC §10, §13.1).
2. Under jamming from the start of a session, the heading comes from matching the OBD + gyro track to the roads,
   sooner than alignment to coarse fixes (450–600 m today, NAVIGATOR-SPEC §6).
3. Ambiguity is shown, not hidden: when two roads fit, both stay alive until a turn decides between them.
4. It works the same for one oblast and for the whole of Ukraine, on the JS thread, within a few ms per update.

## 2. Status (2026-10-04)

- **M1 done:** `tools/tiles/tiles/graph.py` builds `<region>.graph.bin` (`tiles graph`, and part of `build-all`).
  Measured in §4.7.
- **M2 done:** the TS reader `src/nav/mapmatch/graph/` (§5), `npm run replay:graph`, and a roads layer in
  `replay:view`. Measured in §5.1.
- **M3 done:** the navigator's odometry output (§6.1), the ground-truth HMM (§10.1), `npm run replay:truth`, and
  a truth layer in `replay:view`. Measured in §10.4.
- **M4 done:** the particle filter `src/nav/mapmatch/particle-filter.ts` (§7), run by the navigator
  (`setRoadGraph`) open loop; `npm run replay:mm`, `replay:bench --mm`, particles in `replay:view`. Measured in
  §7.7.
- Next: M5 (heading init from the map) and M6 (closed loop). Order of work in §12.

## 3. Decisions

| Topic | Decision |
| --- | --- |
| Method | Road-constrained particle filter (PF) in pure TS, `src/nav/mapmatch/` (SPEC §2). No HMM for live matching. |
| Graph | Our own graph, **one file per region** (`<region>.graph.bin`), `ukraine` included. No cross-region navigation: the active region is the whole world. |
| Large regions | The file is tiled internally (z14) and read by random access. Only tiles near the live hypotheses are decoded, so cost and memory depend on the hypothesis spread, not the region size (§5). |
| Builder | Python, **pyosmium** (`osmium` on PyPI, native Windows wheels) in `tools/tiles`. Shapely for simplification. |
| OSM rules | **Soft.** One-way, turn restrictions and U-turns change branch probabilities; they never make a hypothesis impossible (§7.3). OSM tags are sometimes wrong (SPEC §9.11). |
| Heading init from the map | **Core scope.** Under jamming the PF starts with unknown heading and can start the EKF (§8). |
| Ground truth | Offline HMM matcher on clean satellite fixes, in replay only (§10.1). |

## 4. Road graph builder (`tools/tiles`)

### 4.1 Input and filter

- Input: the region's clipped extract (`cache/extracts/<region>.osm.pbf`); for `ukraine`, the Ukraine extract.
- Kept: ways with `highway` = `motorway`, `trunk`, `primary`, `secondary`, `tertiary` (each with its `_link`),
  `unclassified`, `residential`, `living_street`, `service`, `track`, `road`.
- Dropped:
  - `footway`, `path`, `cycleway`, `steps`, `pedestrian`, `bridleway`, `corridor`, `construction`, `proposed`,
    `platform`, `raceway`, `busway`;
  - `area=yes`;
  - `access` / `motor_vehicle` / `motorcar` = `no`.
- Access: the most specific of `motorcar`, `motor_vehicle`, `vehicle`, `access` wins. `no` drops the way. A value
  with none of `yes`, `designated`, `permissive`, `destination`, `customers`, `official`, `unknown` (e.g. `private`,
  `agricultural;forestry`, `delivery`) sets the `private` flag.
- Edge flags: `link`, `roundabout` (`junction=roundabout|circular`), `tunnel`, `bridge`, `private`, `minor_service`
  (`service=driveway|parking_aisle|drive-through|emergency_access`). `service` and `track` are classes (§4.3).
- Ferries are out of scope for v1.
- Memory: Ukraine has far more nodes than the kept ways use. Read ways first, then fetch locations only for the
  nodes those ways reference (two passes, sorted arrays). Don't build a location index of every node. The build
  must fit the same machine as `build-all --heap 8g`.

### 4.2 Topology

- **Nodes** are graph vertices: way ends, OSM nodes shared by two or more kept ways, and nodes a way visits twice.
- **Edges** are the way pieces between consecutive graph nodes. Every edge is undirected, with a one-way attribute.
- A closed way with a single graph node is split in two by an extra node, so no edge is a self-loop.
- Degree-2 nodes where two ways meet stay as nodes; edges are not merged across them.
- **Boundary nodes:** a node outside the region polygon is flagged `boundary`. The extract keeps crossing ways whole,
  so ways end there without being real dead ends (§7.3). For `ukraine`, the polygon is the national border.
- **Geometry:** Douglas–Peucker at 1 m in a local metric projection, endpoints kept.

### 4.3 Edge attributes

- Length (m, of the unsimplified geometry).
- Class (u8): motorway 0, trunk 1, primary 2, secondary 3, tertiary 4, unclassified 5, residential 6,
  living_street 7, service 8, track 9, road 10.
- One-way (u2): none, forward, backward.
  - `oneway=yes/1/true` → forward, `-1` → backward.
  - `junction=roundabout` and `highway=motorway` imply forward unless `oneway=no`.
  - `oneway:conditional` is ignored.
- Flags (§4.1).
- Names are not stored in v1. Routing on this graph (SPEC §9.8) would add them.

### 4.4 Turn restrictions

- Relations with `type=restriction` and `restriction` or `restriction:motorcar`, a `from` way, a `via` **node** and
  a `to` way.
- Dropped: via-way restrictions, and any whose `except` includes `motorcar`.
- The from/to edges are the pieces of those ways that touch the via node.
- `no_*` forbids that one pair. `only_*` forbids every other exit from that from-edge at the via node.
- Stored per via node.

### 4.5 File format (`<region>.graph.bin`, format 1)

Little-endian. Every record is a multiple of 4 bytes, so the reader can use typed-array views over a tile's bytes
without copying.

```
header      64 B   "WTFG", u16 format, u16 zoom (14), u32 x0, y0, nx, ny, u32 nodes, edges,
                   u32 directory offset (64), u32 data offset, char[16] OSM date, u32 build time (unix s), u32 0
directory          u32[nx·ny + 1]: tile i = (y − y0)·nx + (x − x0) spans [off[i], off[i+1]) after the data
                   offset; an empty tile has zero length
tiles              per non-empty tile, in tile order:
  counts    24 B   u32 nodes, incidence, edges, vertices, restrictions, spatial
  nodes     16 B   i32 lon, lat (1e-6°); u32 first incidence; u16 incidence count; u16 flags (1 boundary, 2 dead end)
  incidence  8 B   u32 tile, u16 edge index, u16 end (0: the edge starts at this node, 1: it ends here)
  edges     28 B   u16 from-node (local); u8 class; u8 one-way (0 none, 1 forward, 2 backward); u16 flags;
                   u16 vertex count; u32 to-node tile, u16 to-node index, u16 0; f32 length (m);
                   u32 first vertex; u32 OSM way id
  vertices   8 B   i32 lon, lat (1e-6°); an edge's first and last vertex are its from- and to-node
  restr.    20 B   u16 via node (local); u8 kind (1 no, 2 only); u8 0; u32 from-edge tile, u16 index, u16 0;
                   u32 to-edge tile, u16 index, u16 0
  spatial    8 B   u32 tile, u16 edge index, u16 0
```

- **Directory size:** a dense array over the region's tile range. Ukraine is 827 × 554 tiles, 1.8 MB, read once
  when the file is opened. Chernihiv's is 85 kB.
- **Ids:** a reference is (tile, local index); `GraphId = tile · 65536 + index`, exact in a JS number. The builder
  fails if a tile has more than 65 535 nodes or edges (the densest Ukraine tile is 216 kB in total).
- **Home tile:** an edge lives in the tile of its first node (in OSM way order), and a node in the tile that
  contains it. Local order: nodes by OSM id, edges by way order.
- **Incidence:** each node lists every edge touching it, wherever the edge lives. Following the graph from a node
  needs only the node's tile; reading an edge may need its home tile.
- **Restrictions** are stored as tagged (`only` is not expanded): the reader applies `only` as "every other exit
  from this from-edge".
- **Spatial:** every edge whose simplified geometry crosses the tile, including edges homed elsewhere. "Edges near
  a point" is the union over the tiles the query circle touches.
- **OSM way id** (u32; current ids are below 2³¹) is for debugging, the viewer, and HMM break reports.
- **Compression:** none in format 1 (§4.7).
- `tiles graph-check <file>` validates a file: geometry ends at its nodes, incidence matches the edges, every edge
  is in its home tile's spatial list, counts match the header.

### 4.6 Release

- `build-all` and `build-region` write `<region>.graph.bin` next to `<region>.pmtiles`. `tiles graph [regions]`
  builds only the graphs (from the cached extracts) and rewrites `index.json`.
- `index.json` gains an optional per-region `graph` entry: `{ asset, size, md5, sha256 }`. `INDEX_FORMAT` stays 2.
  A region without `graph` is display-only.
- The `maps-*` workflow publishes the graph files as release assets like the rest.
- `tools/tiles/tests/test_graph.py` covers the tag rules, splitting (shared nodes, closed ways, loops, missing
  nodes), simplification, node flags, restriction mapping, spatial lists across tiles, and the file round trip.
  The TS reader (M2) gets its own fixture from the same builder.

### 4.7 Measured (OSM 2026-10-03, Windows PC)

| Region | File | Edges | Nodes | Tiles | Build | Peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| `chernihiv` | 14.6 MB | 132 k | 102 k | 11.8 k | 6 s | — |
| `ukraine` | 452 MB | 4.34 M | 3.36 M | 206 k | 2 min 20 s | 2.9 GB |

- Ukraine: 2.08 M kept ways, 24.6 M vertices → 19.8 M after simplification. Restrictions: 35 k mapped, 1.9 k
  dropped (via way, or the way passes through the via node). The median tile is 0.8 kB, the largest 216 kB.
- Where the bytes go (Ukraine): vertices 35 %, edges 27 %, incidence 15 %, nodes 12 %, spatial 9 %.
- **Download:** the Ukraine graph adds 38 % to its 1.2 GB display pack; an oblast's (~15 MB) is small next to its
  36–89 MB pack.
- **Compression:** per-tile deflate gives 1.85× (Chernihiv). Not used in format 1, because it would need a JS
  inflater on every tile load. If the Ukraine size matters, the cheaper option is delta-encoded i16 vertices
  (§15.1).
- Simplifying all 4.3 M edges with shapely at once peaked at 9 GB; in chunks of 200 k edges the peak is node pass 2.



## 5. Reader (`src/nav/mapmatch/graph/`)

- Pure TS, no Expo imports. The file is reached through:

  ```ts
  interface ByteSource { size: number; read(offset: number, length: number): Uint8Array } // synchronous
  ```

  - Node: `fs.readSync` with a position (`tools/replay/graph-file.ts`); tests: `bufferByteSource`.
  - Device (M7): an `expo-file-system` `FileHandle`: set `offset`, then the synchronous `readBytes(length)`. This
    lives in `src/services`. Verify on device that seeking and reading a tile stays under 1 ms.
- **`RoadGraph` interface** (all the PF sees; `TiledRoadGraph` implements it):
  - `edgesNear(e, n, radius)`: edges within the radius, nearest first, with distance, closest point, distance along
    the edge and the geometry heading there;
  - `edge(id)`: class, one-way, flags, OSM way id, OSM length, geometry in degrees and in ENU, and cumulative
    distance along the (simplified) geometry. Travel along an edge uses the geometry length; the OSM length differs
    by well under 1 %;
  - `exits(via, dir)`: every way out of the node reached along `via` in direction `dir` (+1 along the geometry),
    each with its own direction, turn angle (clockwise positive), and `againstOneway` / `restricted` / `uTurn`.
    The PF applies the soft factors (§7.3); the reader only reports;
  - `node(id)`: position, flags and every incident edge.
- Also on `TiledRoadGraph`: `tilesAround(e, n, r)`, `tilesInBounds`, `tileAt`, `edgesInTiles`, `pin(tiles)` (the
  working set), `setFrame(frame)`, `info` (header) and `stats` (tile loads, bytes read).
- **Frame:** decoded geometry is converted to the navigator's local ENU frame. `setFrame` on re-anchoring
  (NAVIGATOR-SPEC §4) drops the decoded edges and nodes; the tile bytes stay cached.
- **Working set:**
  - After each resample, and at least every 50 m of travel, the required tiles are those inside circles around each
    cluster (radius = 3 × cluster spread + 300 m), plus the init area (§7.2).
  - Missing tiles are loaded. Decoded tiles sit in an LRU cache of 128 tiles, and pinned tiles are never evicted.
  - A particle that steps onto a node or edge in an unloaded tile loads that tile synchronously. This should be
    rare given the 300 m margin.
- **Consequence:** opening the Ukraine file reads its 1.8 MB directory. After that it behaves like an oblast file.
  The cost scales with how far apart the hypotheses are, which §7.2 bounds.
- **Tests:** `src/nav/mapmatch/__tests__/road-graph.test.ts` on `__fixtures__/net.graph.bin`, which the Python
  builder writes (`UPDATE_FIXTURES=1 python -m pytest`; a stale fixture fails `tools/tiles` tests).

### 5.1 Measured (`npm run replay:graph`, Node on the Windows PC)

On the 5 drives with clean moving satellite fixes (≤ 10 m, ≥ 3 m/s; 30–276 per drive):

| | Value |
| --- | --- |
| Fix → nearest road | median 1.7–3.2 m, p99 3.4–7.8 m; none farther than 15 m |
| GNSS course vs road heading (roads ≤ 10 m away) | median 0.1–0.5°, p90 1.0–6.5° |
| Open | 0.1 ms (oblast), 0.8 ms (Ukraine: the 1.8 MB directory) |
| Tile load | 0.07–0.3 ms typical, one 1 ms outlier |
| `edgesNear(50 m)` from cached tiles | 40–90 µs |
| Tiles per Slavutych drive | 6–12 |

- The oblast and Ukraine files give identical matches and load the same tiles.
- Checked by eye (roads, one-way arrows, junction and dead-end nodes under the fixes) on drive q8tfjs. The only
  place the car leaves the graph is a yard at the end of a service road, the off-road case of §7.1.

## 6. Navigator interface

### 6.1 Odometry output (navigator → PF, `src/nav/odometry/odometry-output.ts`)

`ekf.predict` used the speed and turn of each IMU step, then discarded them. `Navigator.subscribeOdometry(listener)`
now hands them out (computed only while someone listens; `flushOdometry()` at the end of input; replay option
`odometry`):

- **Chunks** (`OdometryStep`): each integration step's `Δs` and `Δψ`, summed into chunks of 2 m or 0.2 s
  (whichever comes first; a change of source closes one early). Each chunk carries:
  - `t0Us`, `t1Us`; `dsM` (≥ 0), `dpsiRad` (clockwise positive, like the heading) and their variances;
  - `distanceM` and `turnRad`: cumulative distance and unwrapped cumulative turn since the navigator started. The
    PF reads windows from them (§7.4);
  - flags: `stopped` (the whole chunk at standstill or zero speed), `yawUnknown` (gyro invalid while moving:
    `Δψ` = 0 with handling noise), `speedUnknown` (OBD stale);
  - `source`.
- **Source:**
  - `ekf` (mode `dr`): computed from the state before each prediction, so it is exactly the EKF's own motion:
    `Δs = max(0, v)·dt` (v ≈ `k_s · s_OBD`), `Δψ = −k_ω (ω − b_ω) dt`, 0 while holding at standstill.
  - `relative` (before the EKF starts): OBD × the stored `k_s` (NAVIGATOR-SPEC §7.4, default 1), and the gyro
    minus the bias learned at stops, `k_ω` = 1. This is what makes §8 possible.
- **Variances:** `dsVar = (σ_ks/k_s · Δs)² + (0.1 m/s · T)²` (scale error correlated over the chunk, plus OBD
  resolution); `dpsiVar` = gyro white noise (`(gyroNoise·k_ω)²·T`, or the handling noise while the gyro is
  invalid) + `(σ_bω·T)²` + `(σ_kω·Δψ)²`. Calibration σ come from the EKF, or its priors in `relative`.
- No raw sensor data crosses this interface. Stage 2/3 odometry sources feed the same output (SPEC §2.1).
- **Tests** (`src/nav/__tests__/odometry.test.ts`, synthetic city drive): chunks of ≤ 2 m / 0.2 s; during a GNSS
  cut, Σ`Δψ` over 50 s including a 90° turn equals the EKF heading change to < 0.05°, and Σ`Δs` its path to 1 %;
  totals match the true distance to 1 % and the true turn up to the gyro bias the EKF hasn't learned yet.

### 6.2 PF output (PF → navigator → map)

- `NavEstimate` gains `mapMatch?`:
  - `state`: `off` | `init` | `tracking` | `multimodal` | `offroad`;
  - `clusters`: up to 5, by weight: `{ weight, lat, lon, headingRad, spreadM, edgeId }`;
  - `particles`: the particle count;
  - `updateMs`: the time the last PF update took.
- **Map puck:**
  - `tracking`, `multimodal` or `offroad`: the dominant cluster, with radius = its spread (68 %). Alternatives are
    drawn as secondary markers (SPEC §3.9). An off-road cluster follows the car into yards and parking areas better
    than the EKF (measured in replay: showing the EKF instead doubled the 240 s end error, §7.7).
  - `off` or `init`: the EKF as today.
- **Integrity** (SPEC §3.3), when it exists, uses all clusters.

## 7. Particle filter (`src/nav/mapmatch/`)

Arrays of numbers, not objects (structure of arrays over typed arrays), for Hermes. Starting values are in §13.

### 7.1 Particle state

- **On-road:** `edgeId`, `offsetM` along the edge, `dir` (+1 or −1 along the geometry), `dks` (distance-scale
  perturbation), `roadTurn` (cumulative unwrapped road-heading change along this particle's path), `anchorTurn`
  (`roadTurn` at the last turn comparison, §7.4), `weight`. Position and travel heading are kept for all particles.
- **Off-road:** `e`, `n`, `psi`, `dks`, `weight`.
- At least 5 % of particles are off-road (§7.5).

### 7.2 Initialization

- **Known heading** (EKF running; parked pose; manual fix):
  - Candidate edges within 3σ of the position, travel directions within 3σ_ψ + 10° of the heading.
  - Particles are spread over them by the position likelihood.
- **Unknown heading** (navigator `anchored`, §8):
  - All edges within the anchor radius, both directions (one-way soft), uniform along their length.
  - Particle count = total road length × 2 directions ÷ 10 m, clamped to [`N_track`, `N_max`].
  - If the anchor radius exceeds 1 km, wait: the cost and the hypothesis count would both be too high.
- **Re-init:** after a navigator reset (NAVIGATOR-SPEC §4), after `offroad` lasting 300 m, and when the region
  changes.

### 7.3 Propagation (per odometry chunk; frozen at standstill)

- **On-road:** advance `Δs · (1 + dks)` plus noise.
- **At a node,** choose the next edge among the node's exits, with probability ∝ uniform × soft factors:

  | Case | Factor |
  | --- | --- |
  | against a one-way | 0.02 |
  | restricted turn (`no_*`, or not the `only_*` exit) | 0.05 |
  | U-turn at a node that isn't a dead end | 0.01 |
  | `private` / `service` edge | 0.3 / 0.5 |

  - The measured turn isn't used to pick the branch. It isn't complete when the particle reaches the node.
    Weighting (§7.4) prunes the wrong branches over the next metres.
  - Dead end: the particle turns around.
  - Boundary node: the particle becomes off-road.
- **U-turn on an edge:** allowed when the measured turn over the last 20 m exceeds 135°. A small share of the
  particles reverses `dir`.
- **`roadTurn`:** accumulates the road-heading change along the particle's path, from geometry vertices and junction
  angles.
- **Off-road particle:** unicycle step with `Δs·(1 + dks)` and `Δψ`, plus heading noise (0.01 rad/√m). With 2 %
  probability per step, an off-road particle within 5 m of an edge, heading within 20° of it, snaps onto the edge.
- **Stopped chunks** (speed below 0.2 m/s) freeze the particles.
- **`yawUnknown` chunks:** junction choice stays uniform, and the next relative-heading weight is skipped.

### 7.4 Weighting

Every 10 m of travel, plus each accepted fix. All terms are log-likelihoods, summed.

- **Relative heading (main term):** the car's measured turn against each particle's road turn, between two
  *comparison moments*, not over a sliding window:
  - A comparison happens when the car drives straight (turned < 8° over the last 10 m), so a whole turn lies
    inside it for the car and for the road. Mid-turn the car turns gradually while a polyline turns at its
    vertex, and a few metres of along-track offset looked like a 50° heading error (the first version, with a
    30 m sliding window, put the filter off-road at every turn entry).
  - Also when the car halts (a turn into a parking space or yard), and after 20 m without a straight moment (a
    curve, or manoeuvring in a yard: it is the evidence that the car left the roads).
  - Gaussian with σ² = gyro variance since the last comparison + σ_road² (5°) + (10 % of the turn)², or 30 % of
    the turn for a forced (curve) comparison. Skipped when the gyro was invalid since the last comparison.
  - It uses heading changes, so gyro drift and absolute heading error don't matter. Particles still before the
    vertex when the car has finished turning are pruned: turns correct the along-track error.
- **Absolute heading (weak, `dr` mode, straight moments only):** EKF ψ versus the particle's travel heading, with
  the EKF σ_ψ widened ×3, the term scaled by 0.3. It mostly separates the two directions on a straight road.
- **EKF position (weak, `dr` mode; added in M4):** distance to the EKF position, σ = max(2 × EKF σ, 10 m), term
  scaled by 0.3. In open loop the EKF position carries the absolute heading it integrated; without it, a
  hypothesis on a road 50 m from a 6 m-accurate EKF could win. It must be revisited for the closed loop (§9).
- **GNSS position** (fixes the navigator accepted):
  - Satellite fixes count only 10 m of travel apart: their errors are correlated, and at a standstill repeated
    fixes made the off-road particles (which can sit exactly at a biased fix) win over the road.
  - On-road particles: the first 3 m from the fix cost nothing (lane offset from the centre line), then σ =
    `h_acc/1.5` ⊕ 2 m. Off-road particles: distance as is.
  - Coarse fixes (NAVIGATOR-SPEC §3): σ = `h_acc` × 2 for their correlated errors, 25 m of travel apart.
  - Compared at fix time, shifted back along the particle's travel direction by GNSS lag × speed.
  - A fix more than 5σ + 3 m from every particle means the filter lost the car: it restarts around the EKF.
  - Until integrity exists, the navigator's acceptance decides which fixes count.
- **Off-road:** a fixed penalty (×0.5) per 10 m, instead of the relative-heading term.

### 7.5 Resampling and particle count

- Systematic resampling when ESS < N/2.
- Off-road share kept ≥ 5 %.
- On-road share kept ≥ 10 %: off-road particles are projected onto the nearest edge within 15 m whose direction
  fits within 30°. While off-road dominates, on-road hypotheses stay where the car will come back onto a road.
- 2 % of particles re-injected around the clusters: nearby edges, both directions when the cluster is new.
- `dks` jittered at resampling.
- **Count:** `N_track` = 500 while tracking. Above that only during init (§7.2), shrinking back to `N_track` at
  resampling once the spread allows.
- Never let the truth vanish: re-injection plus the soft rules are what SPEC §7.5 relies on. The replay measures it
  (§10.2).

### 7.6 Clusters and state

- **Greedy clustering** in weight order: a cluster is the particles within 30 m of the seed and with travel heading
  within 45°, so opposite directions on one road are different hypotheses.
- **Cluster values:** weight, weighted mean position, circular-mean heading, spread (weighted RMS distance), the
  edge holding the most weight.
- Clusters mix on- and off-road particles; a cluster's edge is the one holding most of its on-road weight (null:
  all off-road).
- **States:**
  - `tracking`: top cluster ≥ 0.9 of the weight and spread ≤ 25 m;
  - `multimodal`: otherwise, while on-road;
  - `offroad`: off-road particles hold > 50 % of the weight;
  - `init`: unknown-heading start until the first `tracking` (§8);
  - `off`: no graph, or not initialized.

### 7.7 Integration and measurements (M4)

- **Navigator** (`setRoadGraph(graph, config)`): starts the filter whenever the EKF starts (known heading) and again
  when a fix says it is lost, or after 300 m off-road; stops it at an EKF reset. It feeds the odometry (flushed at
  each fix, so the filter is at the fix time), the EKF pose, and accepted fixes; moves the graph's frame with the
  navigator's. `estimate().mapMatch` reports state, up to 5 clusters (lat/lon), particle count and update time.
- **Replay** (`replayTrip` option `mapMatch: { graph, truth, config, particlesEveryS }`): the §10.2 metrics, the
  dominant cluster's error at held-out fixes in cuts, particle snapshots for the viewer.
- **Tests** (`src/nav/mapmatch/__tests__/particle-filter.test.ts`, synthetic drives on the fixture graph): with GNSS
  cut 50 s before a junction, the filter takes the branch the car turned onto and ends within 25 m; a turn into
  open country hands over to the off-road particles; no filter without a graph.

With GNSS (no cuts), `npm run replay:mm`:

| Drive | Samples | Wrong road | Truth survival | Multimodal | Off-road |
| --- | --- | --- | --- | --- | --- |
| q8tfjs | 280 | 0.7 % | 100 % | 7.9 % | 0.4 % |
| 5mn7ai | 259 | 1.9 % | 99.2 % | 6.2 % | 3.1 % |
| 6vccgr | 119 | 0 % | 100 % | 14.3 % | 5.9 % |
| s4fkdm | 115 | 0.9 % | 100 % | 15.7 % | 0.9 % |
| 79xky3 | 28 | 0 % | 100 % | 7.1 % | 0 % |

- The one survival miss is the 2 s after 5mn7ai leaves the unmapped yard (§10.4): the filter is off-road and
  re-locks on the road a moment later.
- Update time (Node, 500 particles): p50 0.06–0.10 ms, p99 0.4–0.9 ms; single updates up to 7 ms (not yet broken
  down: starts, tile loads and GC are candidates).

Outages (`npm run replay:bench -- --mm`, same windows as NAVIGATOR-SPEC §10; filter open loop):

| Outage | Windows | Max error median / p90: EKF | Map match | End error median / p90: EKF | Map match | Map match max better |
| --- | --- | --- | --- | --- | --- | --- |
| 60 s | 21 | 11.1 / 20.8 m | 10.4 / 16.2 m | 9.5 / 20.8 m | 7.0 / 15.5 m | 9 of 21 |
| 120 s | 19 | 19.9 / 31.3 m | 16.1 / 49.2 m | 19.2 / 29.3 m | 6.9 / 19.5 m | 14 of 19 |
| 240 s | 16 | 37.1 / 87.6 m | 30.5 / 64.0 m | 32.9 / 84.8 m | 14.8 / 48.0 m | 9 of 16 |

- The end of an outage is where map matching pays: turns reset the along-track error (240 s: 15 m instead of 33 m).
- The worst windows are low-speed manoeuvring around yards and service roads (q8tfjs 920–1100 s, the 5mn7ai yard):
  reversing reads as driving forward (unsigned OBD speed), and the filter spends 20–30 m deciding between road and
  off-road. Windows overlap, so these few events weigh in several windows each (120 s p90).
- Tuning that mattered, in order: straight-moment comparisons (off-road share at turns 7–23 % → 0–6 %), fix spacing
  and the lane dead zone (no off-road takeover at a standstill), the EKF position prior (no 50 m excursions to
  nearby roads), the halt and 20 m forced comparisons (yards), the on-road floor.

## 8. Heading initialization from the map (jammed start)

Under jamming the navigator sits in `anchored` (position known to ±hundreds of metres, heading unknown) until a
GNSS course or alignment starts the EKF (NAVIGATOR-SPEC §6). The PF can resolve both faster. It only needs relative
odometry, which doesn't depend on the absolute heading.

- **Start:** in `anchored`, with a graph and an anchor radius ≤ 1 km. PF init with unknown heading (§7.2).
- **Inputs:** the odometry output in `anchored` mode (§6.1), the relative-heading weight, the coarse-fix weight and
  the off-road penalty. There is no absolute heading.
- **EKF start:** when the state stays `tracking` over 100 m of driving.
  - Position = cluster mean, with σ = max(spread, 5 m).
  - ψ = the circular mean of particle headings, with σ = max(heading spread, 3°).
  - App note: `nav init map`.
- **Order:** whichever comes first among GNSS course, alignment and map. After the start, the existing checks apply:
  five satellite fixes failing the gate reset to `anchored`.
- **Ambiguity:**
  - On a straight road both directions stay alive until a turn or the coarse fixes separate them.
  - In a grid, all junctions with the same turn sequence stay alive until fixes or further turns separate them.
  - Unimodality is the rule; no extra rule ("needs N turns") is added.
- **Measured** on the real jammed drives and on simulated jams of clean drives (§10.3):
  - distance driven to EKF start;
  - heading and position error at the start;
  - versus alignment.

## 9. Closed loop (PF → EKF)

- **When:** state `tracking`, navigator in `dr`, every 25 m of travel. The interval limits the correlation, because
  the PF itself runs on the EKF's increments.
- **Road heading:**
  - σ = 2°, only where the road is straight within ±15 m and not within 20 m of a node.
  - Sent also while GNSS is trusted. It is the candidate fix for the ~2° heading error at outage start
    (NAVIGATOR-SPEC §13.1).
- **Position:**
  - From the cluster's weighted covariance, floored at 3 m across the road and 5 m along it.
  - **Not sent while GNSS is trusted.** The PF already weighs the same fixes, so sending it would count them twice.
- Both use the EKF χ² gate (16). A rejection is an app note, not a reset.
- **The EKF-position term of the filter (§7.4)** feeds the EKF back into the filter. With the loop closed, the
  filter would partly confirm its own corrections: turn it off, or weaken it, while pseudo-measurements are sent,
  and check max error ÷ σ in replay.
- Replay switch: `--mm off | open | closed`. Open loop = PF runs and is scored but sends nothing.

## 10. Replay, ground truth and metrics

### 10.1 Ground truth (`src/nav/replay/truth-match.ts`)

- Offline Viterbi HMM over satellite fixes ≤ 10 m (the same truth rule as NAVIGATOR-SPEC §10). An HMM is right here:
  clean GNSS has independent, bounded errors, and the matcher sees the whole drive.
  - **States:** the 8 nearest edges within 30 m, each in both directions, at the fix's projection.
  - **Emission:** N(distance; 5 m), times N(course − travel direction; 20°) when the fix moves at ≥ 3 m/s.
  - **Transition:** exp(−(|route − OBD distance| + penalty) / β), β = 5 m + 5 % of the OBD distance. The **OBD
    distance** driven between the fixes, not the straight line, so curves don't count against a route. Routes come
    from a Dijkstra over the graph's exits, bounded to 1.5 × OBD + 50 m.
  - **Penalties** (m): against a one-way 200, restricted turn 100, U-turn 100 (free at a dead end). Soft, so a
    wrong OSM tag can't break the truth; a penalised leg is reported.
  - Projection up to 10 m back along the same edge is fix jitter, not a reversal.
- **Output:** the true edge, direction and position along the edge at each fix; the route between consecutive
  fixes; `at(t)` interpolates along it by OBD distance.
- **Breaks** end a chain:
  - `no candidates`: no road within 30 m. Consecutive ones form one break: the car is off the graph (yard,
    parking area, unmapped road).
  - `gap`: more than 30 s between clean fixes. The report counts the fixes in it that aren't clean (degraded GNSS
    rather than none).
  - `no route`: no route fits the OBD distance. Points at missing or wrong OSM roads.
- **Same road** (`isSameRoad`): the same edge, or an edge sharing a node with the truth edge while the truth position
  is within 15 m of that node (junction tolerance).
- **Tests** (`src/nav/replay/__tests__/truth-match.test.ts`, fixture graph): a right turn at a junction, a turn
  against a one-way (matched, penalised), an off-graph stretch as one break, a gap, the junction tolerance.

### 10.2 Metrics

| Metric | Definition |
| --- | --- |
| Wrong-road rate | Share of moving time the dominant cluster is not on the truth road (SPEC §3.10) |
| Truth survival | Share of moving time at least one particle is on the truth road; target 100 % outside HMM breaks |
| Re-lock time | From entering `multimodal` to `tracking` on the truth road (s and m) |
| Multimodal share | Share of moving time in `multimodal` |
| Position error | Dominant cluster versus held-out fixes, in the `replay:bench` windows (NAVIGATOR-SPEC §10), next to the EKF |
| Heading init | Distance to EKF start and heading error at start (§8), versus alignment |
| Update time | PF update p50 / p99 (ms) in Node; on device from `nav_mapmatch` |

### 10.3 Tooling (`tools/replay`)

- `npm run replay:mm -- [--graph <file>] [--cut s:len]… [--open-loop] [--mm '<json config>'] [--trace from:to] <logs>`
  (M4): the §10.2 metrics per drive, wrong-road and lost stretches, update time, filter vs EKF error in cuts;
  `--trace` prints per second the state, top clusters (OSM way, weight, spread), the true way, both errors.
- `npm run replay:bench -- --mm [--mm-config '<json>']` (M4): the outage benchmark with the filter's columns.
- `npm run replay:truth -- [--graph <file>] [--json <out>] <logs>` (M3): chains, breaks with their reason and place,
  moving-fix distance to the road, route vs OBD vs navigator odometry, legs that don't fit, penalised legs.

- `npm run replay:graph -- [--graph <file>] <logs>` (M2): fix-to-road distance, course vs road heading, reader
  timing (§5.1).
- Graph choice: `--graph <file>`, else the smallest `tools/tiles/out/release/*.graph.bin` with roads at the trip's
  first fix (the oblast rather than Ukraine).
- `replay --graph <file>` loads a graph through the Node `ByteSource`. Without one, replay behaves as today.
- `--mm off|open|closed` (default `open` with a graph).
- `--jam start:len` simulates jamming:
  - satellite fixes in the window become coarse ones: no speed or course, a correlated random-walk error of
    30–100 m, reported `h_acc` 65 m;
  - 0.1–0.2 Hz, with repeats.
- `replay:bench` gets PF columns. A `--jam-start` bench runs §8 on every clean drive.
- **Viewer layers:**
  - graph edges, colored by class, one-ways marked (done in M2: roads around the trip's fixes, junction, dead-end
    and boundary nodes at zoom ≥ 15, hover for way id, class, length, flags; `replay:view -- --graph <file>`);
  - truth route (done in M3: the matched route, the leg at the cursor thick, breaks as × with their reason on hover);
  - the particle cloud at the cursor time, and clusters with their weights (done in M4: particles once a second,
    200 heaviest, size by weight; clusters as rings sized by spread, labelled with weight and state).
- **Logs:** all 7 current logs are from Slavutych, a small planned town. Parallel-road and dense-grid cases (SPEC §7.5)
  need drives elsewhere: Kyiv, or Chernihiv's ring roads. Record some before calling M5 done.

### 10.4 Measured (M3, `npm run replay:truth`)

| Drive | Clean fixes matched | Moving fix → road (median / p95) | Route / OBD / odometry | Breaks |
| --- | --- | --- | --- | --- |
| q8tfjs | 402 of 422 | 2.1 / 6.0 m | 2.98 / 2.87 / 2.94 km | 1: off the graph (yard at the end, 20 fixes) |
| 5mn7ai | 656 of 672 | 3.2 / 6.4 m | 3.32 / 3.27 / 3.34 km | 1: off the graph (yard, 16 fixes) |
| 6vccgr | 196 of 196 | 2.2 / 7.5 m | 1.18 / 1.12 / 1.14 km | 2: gaps of 30 and 38 s, fixes 11–27 m |
| s4fkdm | 308 of 308 | 1.8 / 4.8 m | 1.05 / 1.01 / 1.01 km | none |
| 79xky3 | 45 of 45 | 2.0 / 2.7 m | 0.51 / 0.47 / 0.48 km | none |

- No `no route` break on any drive. Every break was checked on a map: two are the car driving off the graph into
  an unmapped yard, two are stretches of degraded GNSS.
- Routes are 1–7 % longer than OBD: OBD reads ~2 % low on the CX-5 (NAVIGATOR-SPEC §5.2), and the centre line is
  not the driven line. The navigator's odometry (`k_s` learned) is 0.7 % above to 5.4 % below the route.
- Of 725 moving legs, one doesn't fit its OBD distance (a 1 s fix jump). No leg needed a penalty.
- 7–64 ms per drive in Node.

## 11. App

- **Downloads:** fetches `graph` together with the region's `.pmtiles`, using the same checks, into
  `Documents/maps/`. Regions downloaded before this change get their graph through the existing update check.
- **NavigatorService:**
  - opens the active region's graph (`FileHandle` `ByteSource`, §5) and passes the `RoadGraph` to the navigator;
  - a region change restarts the PF;
  - without a graph, `mapMatch` is `off` and everything works as today.
- **Trip log:** new ULog message `nav_mapmatch`, published with each `nav_estimate` (~2–3 Hz):
  - state, particle count, cluster count;
  - top 3 clusters (weight, lat, lon, heading, spread);
  - update µs and graph version.

  App notes: `mm init`, `mm state`, `nav init map`, and pseudo-measurement rejections. Add it to TRIP-LOGGER-SPEC
  §6.3. ULog is self-describing, so it's additive.
- **Parked pose:** stays position + heading. Edge ids change between graph versions; the PF snaps onto the graph
  at start.
- **Map:** the dominant hypothesis as the puck and alternatives as secondary markers (§6.2). The `debug` screen gets
  a particle-cloud overlay and cluster weights. The UI details go in UI-SPEC.

## 12. Milestones

| # | Milestone | Exit |
| --- | --- | --- |
| M1 | Graph builder (§4) | `chernihiv` and `ukraine` built; size, build time and peak memory recorded here; pytest green. **Done** (§4.7) |
| M2 | Reader + viewer layer (§5, §10.3) | TS round-trip tests on a fixture; graph drawn over the drives in `replay:view` and checked by eye; tile load time in Node. **Done** (§5.1) |
| M3 | Odometry output + ground truth (§6.1, §10.1) | odometry chunks sum to the EKF's distance and heading change; truth edge sequences for the 4 clean drives with no unexplained breaks. **Done** (§10.4) |
| M4 | PF open loop, known heading (§7) | §10.2 metrics on all drives; dominant-cluster max error on 240 s cuts better than the EKF's 37 m median; truth survival 100 %. **Done** (§7.7): 30.5 m; survival 100 % except 2 s leaving a yard |
| M5 | Heading init from the map (§8) | EKF starts sooner than alignment on the jammed drives and on `--jam-start`, with no start > 10° off |
| M6 | Closed loop (§9) | `replay:bench` better at 120 / 240 s; max error ÷ σ stays within 0.5–2 (NAVIGATOR-SPEC §12.1) |
| M7 | App (§11) | graph download, `nav_mapmatch` in trip logs, alternatives on the map, update time on iPhone < 5 ms p99 |

M1–M3 can partly overlap. M4 needs M1–M3. M5 and M6 are independent of each other.

## 13. Starting values (tune in replay)

| Value | Start | Notes |
| --- | --- | --- |
| `N_track` / `N_max` | 500 / 4000 | §7.2, §7.5 |
| Odometry chunk | 2 m or 0.2 s | §6.1 |
| Weight interval | 10 m | §7.4 |
| Straight moment / forced comparison | < 8° over 10 m / after 20 m, or at a halt | §7.4 |
| σ_road, turn tolerance | 5°, 10 % of the turn (30 % forced) | OSM geometry, corner cutting |
| Lane dead zone / lane σ | 3 m / 2 m | §7.4 |
| Fix spacing (satellite / coarse) | 10 m / 25 m | correlated errors |
| Coarse-fix σ inflation | × 2 | correlated errors |
| Absolute heading | EKF σ_ψ × 3, scale 0.3 | §7.4 |
| EKF position prior | σ = max(2σ, 10 m), scale 0.3 | open loop only (§9) |
| Off-road penalty | × 0.5 per 10 m | §7.4 |
| On-road floor while off-road | 10 %, projection ≤ 15 m, ≤ 30° | §7.5 |
| `dks` prior / jitter | 0.02 / 0.002 | per-particle distance scale |
| Off-road share / re-injection | 5 % / 2 % | §7.5 |
| Soft-rule factors | §7.3 table | |
| Cluster radius / heading | 30 m / 45° | §7.6 |
| `tracking` threshold | top ≥ 0.9, spread ≤ 25 m | §7.6 |
| Map heading init | `tracking` over 100 m; anchor radius ≤ 1 km | §8 |
| Pseudo-measurement interval / heading σ | 25 m / 2° | §9 |
| Tile cache / working-set margin | 128 tiles / 300 m | §5 |

## 14. Verification targets

1. Wrong-road rate, truth survival, re-lock time and update time are reported for every drive (§10.2). Pass/fail
   thresholds are set after M4's first numbers. Truth survival is 100 % from the start.
2. `replay:bench` with `--mm closed` is no worse than NAVIGATOR-SPEC §10 at 60 s, and better at 120 / 240 s.
3. Jammed start: EKF start from the map before alignment, heading error ≤ 10°, on the real jammed drives and on
   `--jam-start`.
4. Ukraine graph: opening it reads only the header and directory; tracking a drive decodes about as many tiles as
   the oblast graph does.
5. PF update < 5 ms p99 on iPhone at `N_track` (SPEC §7.6).
6. Lint, typecheck, Jest and `tools/tiles` pytest green.

## 15. Open items

1. Graph size (§4.7): Ukraine is 452 MB. Delta-encoded i16 vertices, and endpoints taken from the nodes, would
   cut about a third without a decompressor. Decide with the M2 tile load time and device download experience.
2. The PF and the EKF both use the same odometry. Watch for overconfidence after closing the loop (max error ÷ σ).
3. Correlated coarse fixes may lock a jammed start onto the wrong road. The ×2 σ and the distinct-position rule
   are a first guess.
4. Via-way restrictions, ferries and street names are not in v1.
5. Test drives beyond Slavutych for parallel roads and dense grids (§10.3).
6. Spoofing replay (NAVIGATOR-SPEC §13.6) is needed before integrity can use the clusters.
7. **Reversing.** OBD speed is unsigned, so reversing moves particles forward. It costs most in yards (§7.7).
   PID `A4` (gear) or the accelerometer could tell; check what the CX-5 answers.
8. **Low-speed manoeuvring** decides road vs off-road 20–30 m late; the 120 s p90 is worse than the EKF's because
   of it. More drives with parking and yards are needed before tuning further.
9. **Device timing:** 500 particles take < 1 ms p99 in Node; measure on the iPhone (M7).
