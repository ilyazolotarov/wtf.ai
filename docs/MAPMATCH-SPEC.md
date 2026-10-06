# wtf.ai — Map Matching Specification

Status: draft v2 (2026-10-04). Implements SPEC.md Phase 5 (map matching) and the road-graph item of Phase 0.
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
- **M5 done in replay:** the filter starts at the first fix with the heading unknown and can start the EKF (§8);
  simulated jamming (`--jam`, `--start`) and `replay:bench --jam-start`. Measured in §8.1. Still to do: drives
  beyond Slavutych (§10.3).
- **M7 in the app, driven (2026-10-05, 10 trip logs, both adapters):** the graph downloads with the region, the
  navigator runs the filter on it, the puck follows the dominant hypothesis while dead-reckoning with alternatives
  on the map, and trip logs carry `nav_mapmatch` (§11), with a particle overlay and a simulated outage for testing
  on the road (NAVIGATOR-SPEC §9). It works on the road. Open: the update time on the iPhone is over the 5 ms
  budget (§15.9).
- **M6 done in replay:** the road heading and position go back into the EKF (`mapMatchLoop: "closed"`, §9.2,
  §9.3); the 240 s max error median falls from 59 to 17 m, its p90 from 124 to 20 m, with the truth inside the drawn
  circle 61–65 % of the time. Simulated 3 h city drives without GPS (§9.4): dot median 4–6 m, never lost. A developer
  setting picks it in the app (§11); Full correction is the app's default since 2026-10-05 (replay tools keep the
  open loop as their baseline).
- Next: an app switch to compare the loops on a drive, and a drive for M7. Order of work in §12.

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
  - `clusters`: up to 5, by weight: `{ weight, lat, lon, headingRad, headingSpreadRad, spreadM, edge, particles }`;
  - `particles`: the particle count;
  - `updateMs`: the time the last PF update took.
- **Map puck:**
  - `tracking`, `multimodal` or `offroad`: the dominant cluster, with radius = its spread (68 %). Alternatives are
    drawn as secondary markers (SPEC §3.9). An off-road cluster follows the car into yards and parking areas better
    than the EKF (measured in replay: showing the EKF instead doubled the 240 s end error, §7.7).
  - `off` or `init`: the EKF as today.
- Also in mode `anchored` (heading unknown, §8): state `init` until the filter first tracks.
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
- **Unknown heading** (navigator `anchored`, §8; `initUnknown`):
  - All roads within the anchor radius: 3σ of the anchor fix (σ = `h_acc` for a coarse fix, `h_acc/1.5` for a
    satellite one) plus the distance driven since it, at least 20 m. The parts of the edges inside the circle,
    segment by segment.
  - Placed evenly (systematic) along those parts, once in each direction. Against a one-way, the particle starts
    at the soft factor (0.02).
  - Off-road share (5 %) anywhere in the circle, heading anywhere.
  - Particle count = road length inside × 2 directions ÷ 10 m, clamped to [`N_track`, `N_max`].
  - If the anchor radius exceeds 1 km, wait: the cost and the hypothesis count would both be too high.
- **Re-init:**
  - known heading: after `offroad` lasting 300 m, and when a fix the EKF accepted is more than 5σ + 3 m from
    every particle;
  - unknown heading: the same, around the anchor; after a navigator reset (NAVIGATOR-SPEC §4) the filter
    restarts with the heading unknown;
  - when the region changes (M7).

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
  - Tried, not kept: *a preference for the bigger road* (× 0.5 onto residential, living street, track and `road`
    edges), on the idea that drivers keep to the main roads. Over 10 seeds on the jammed corpus wrong road
    10.4 → 14.1 % and truth survival 96.2 → 94.4 %; on real drives jammed after the start 4.0 → 7.0 % of the time
    > 50 m off; on the nine trips of 2026-10-06 no better. These drives use residential streets, and where the
    turns leave two roads open the prior picks the wrong one. A planned route is the prior that knows (the route
    hint, ROUTING-SPEC §8.6).
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
- **Off-road:** a penalty (×0.5) per 10 m, instead of the relative-heading term. It grows with speed: off-road is
  for yards, parking lots and private-sector lanes, driven at walking pace to ~20 km/h, and hardly anyone drives
  one at 40. From 20 km/h the exponent grows linearly to ×12 at 40 km/h and beyond (×0.5¹² per 10 m), so at road
  speed the filter keeps to the roads unless a turn no road explains says otherwise. Not while the heading is
  unknown (state `init`, §8): the off-road particles would fall below the stale threshold every few weightings,
  and each resampling re-seeds the region, so the filter never settled on a heading. Measured (2026-10-05, the
  app's closed loop): on 6 jammed drives scored by where they ended (`replay:places`, 5 seeds each) runs ending
  > 50 m off 3/30 → 1/30, off-road share 18 → 8 %, and the off-road cluster no longer crossed roads (4 → 0,
  `replay:crossings`); jammed from the start on the 14 clean drives (`replay:mm --jam 0:inf`, 3 seeds) wrong road
  24.4 → 10.3 % of samples, off-road 28 → 12 %. The cost, on outages after good GPS (`replay:bench --mm`, 6 seeds):
  240 s max error p90 37 → 43 m (median 22.5 → 24.1 m; 60 s and 120 s unchanged), mostly where the car braked
  from 40 km/h and turned into a parking spot: the filter kept to the road ~10 s longer. A gentler ramp
  (30 → 50 km/h, ×6) kept that at 38 m but left wrong road at 16.5 %. A dot a little late in a yard is far less
  bothersome than one driving through buildings beside the road the car is on.

### 7.5 Resampling and particle count

- Systematic resampling when ESS < N/2, and when the off-road particles hold less than 10⁻⁵ of the weight. Their
  penalty accumulates while the car follows a road, and without resampling they drift off it (heading noise):
  when the car then left the road, none was near it or heavy enough to take over (found by the M5 tests, where
  the filter now runs from the first fix). Resampling makes fresh off-road copies of the on-road particles.
- Off-road share kept ≥ 5 %, except **at road speed** (`offRoadSpeed.fullMps`, 40 km/h, and above): no yard is
  driven that fast, so no off-road particles are kept and every off-road particle is put back on the nearest
  aligned road within `onRoadRecoverProjectM` (45 m). The penalty alone (§7.4) could not do it: it moves weight
  from off-road particles onto on-road ones, and with the cloud past 15 m from every road there are none, so it
  spreads over the off-road particles and normalisation cancels it.
- On-road share kept ≥ 10 %: off-road particles are projected onto the nearest edge within 15 m whose direction
  fits within 30°. While off-road dominates, on-road hypotheses stay where the car will come back onto a road.
- 2 % of particles re-injected around the clusters: nearby edges, both directions when the cluster is new.
- `dks` jittered at resampling.
- **Count:** `N_track` = 500. Above that only for an unknown-heading start (§7.2): it keeps its count until the
  filter first tracks, then shrinks to `N_track` at the next resampling.
- **Re-seeding while the heading is unknown:** until the first `tracking`, 5 % of the particles are re-seeded at
  each resampling on all roads of the navigator's current anchor circle, with a neutral turn history. A true road
  pruned early (an unmapped yard, an unlucky turn sequence) can come back. It raised map starts on the simulated
  jams from 25 to 30 of 35 (§8.1).
- Never let the truth vanish: re-injection plus the soft rules are what SPEC §7.5 relies on. The replay measures it
  (§10.2).

### 7.6 Clusters and state

- **Greedy clustering** in weight order: a cluster is the particles within 30 m of the seed and with travel heading
  within 45°, so opposite directions on one road are different hypotheses. It stops after 64 clusters or once
  1 − 10⁻⁴ of the weight is assigned (an unknown-heading start has hundreds of tiny ones).
- **Cluster values:** weight, weighted mean position, circular-mean heading and its circular spread, spread
  (weighted RMS distance), the edge holding the most weight.
- Clusters mix on- and off-road particles; a cluster's edge is the one holding most of its on-road weight (null:
  all off-road).
- **States:**
  - `tracking`: top cluster ≥ 0.9 of the weight and spread ≤ 25 m;
  - `multimodal`: otherwise, while on-road;
  - `offroad`: off-road particles hold > 50 % of the weight;
  - `init`: unknown-heading start until the first `tracking` (§8), instead of `multimodal` or `offroad`;
  - `off`: no graph, or not initialized.

### 7.7 Integration and measurements (M4)

- **Navigator** (`setRoadGraph(graph, config)`): starts the filter with the heading unknown at the first fix (§8),
  or around the EKF when that starts otherwise and the filter doesn't already agree with it; again when a fix says
  it is lost, or after 300 m off-road. It feeds the odometry (flushed at
  each fix, so the filter is at the fix time), the EKF pose, and accepted fixes; moves the graph's frame with the
  navigator's. `estimate().mapMatch` reports state, up to 5 clusters (lat/lon), particle count and update time.
- **Replay** (`replayTrip` option `mapMatch: { graph, truth, config, particlesEveryS }`): the §10.2 metrics, the
  dominant cluster's error at held-out fixes in cuts, particle snapshots for the viewer.
- **Tests** (`src/nav/mapmatch/__tests__/particle-filter.test.ts`, synthetic drives on the fixture graph): with GNSS
  cut 50 s before a junction, the filter takes the branch the car turned onto and ends within 25 m; a turn into
  open country hands over to the off-road particles; no filter without a graph.

With GNSS (no cuts), `npm run replay:mm`, after M5 (the filter runs from the first fix; samples in state `init`
count only for survival, §10.2):

| Drive | Samples (+ init) | Wrong road | Truth survival | Multimodal | Off-road |
| --- | --- | --- | --- | --- | --- |
| q8tfjs | 280 | 0.4 % | 100 % | 8.6 % | 1.8 % |
| 5mn7ai | 267 (+3) | 1.9 % | 100 % | 6.4 % | 1.9 % |
| 6vccgr | 119 | 0 % | 100 % | 14.3 % | 5.9 % |
| s4fkdm | 135 (+3) | 0.7 % | 100 % | 14.1 % | 0 % |
| 79xky3 | 28 (+21) | 0 % | 100 % | 7.1 % | 0 % |

- In M4 the one survival miss was the 2 s after 5mn7ai leaves the unmapped yard (§10.4); now there is none.
- Update time (Node): p50 0.06–0.12 ms, p99 0.4–1.1 ms; single updates up to 8 ms. Starts are counted apart since
  2026-10-05 and weren't the cause: without them the slowest update per drive is still 2.7–8.2 ms (tile loads and
  GC remain the candidates). Starts take 0.3–2.6 ms, up to 10–19 ms for a wide unknown-heading start (vwaz7t,
  3afby6). 3afby6 (no GPS from the start, the filter in `init` with up to 4000 particles for 1.7 km) is the heaviest
  drive: p50 0.53 ms, p99 4.8 ms.

Outages (`npm run replay:bench -- --mm`, same windows as NAVIGATOR-SPEC §10; filter open loop). M4, then after
M5 (with the map, q8tfjs and s4fkdm start their EKF from it, so the EKF columns move too):

| Outage | Windows | Max error median / p90: EKF | Map match | End error median / p90: EKF | Map match | Map match max better |
| --- | --- | --- | --- | --- | --- | --- |
| 60 s, M4 | 21 | 11.1 / 20.8 m | 10.4 / 16.2 m | 9.5 / 20.8 m | 7.0 / 15.5 m | 9 of 21 |
| 120 s, M4 | 19 | 19.9 / 31.3 m | 16.1 / 49.2 m | 19.2 / 29.3 m | 6.9 / 19.5 m | 14 of 19 |
| 240 s, M4 | 16 | 37.1 / 87.6 m | 30.5 / 64.0 m | 32.9 / 84.8 m | 14.8 / 48.0 m | 9 of 16 |
| 60 s, M5 | 21 | 11.1 / 20.8 m | 8.9 / 15.0 m | 9.7 / 20.8 m | 6.4 / 10.9 m | 11 of 21 |
| 120 s, M5 | 19 | 19.9 / 31.3 m | 12.8 / 32.4 m | 19.2 / 28.0 m | 6.8 / 17.9 m | 16 of 19 |
| 240 s, M5 | 16 | 30.2 / 86.5 m | 32.4 / 45.5 m | 24.2 / 84.3 m | 13.7 / 45.5 m | 9 of 16 |

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

- **Start:** in `anchored`, at the first fix with a graph and an anchor radius ≤ 1 km; PF init with unknown
  heading (§7.2). The filter runs from the first fix even when GNSS is clean: a course start then usually finds it
  already tracking.
- **Inputs:** the odometry in `relative` mode (§6.1), the relative-heading weight, every fix (there is no gate yet:
  coarse fixes at σ = `h_acc` × 2, 25 m of travel apart; satellite fixes as in §7.4), the off-road penalty, and
  re-seeding on the anchor's roads (§7.5). There is no absolute heading. After each fix the anchor circle (the
  re-seeding region) follows the navigator's anchor.
- **EKF start** (`initialization.method` = `map`; app note `nav init map`), checked every 10 m of driving:
  - The heading must be settled over 100 m: the filter is `tracking`, or one travel direction (particles within 45°
    of the circular mean) holds ≥ 0.9 of the weight with a heading spread ≤ 10° and a position spread ≤ 150 m.
    The second case is one direction along one road, before the turn that will fix the position along it: the
    map knows the heading long before it knows the position (unit test: a start within 400 m of a dead end).
  - The car drives straight (turned < 8° over the last 10 m), and ≥ 0.9 of the weight is where the road is
    straight (within 5°) over ±(15 m + the position spread). A polyline bends at a vertex, the car gradually,
    and the car is anywhere within the spread: before this rule the three worst starts were 9–10° off, all on
    the right road, just past a 9° bend.
  - Pose: the tracked cluster, or that direction's particles. Position = their mean, σ = max(spread, 10 m).
    ψ = their circular mean, σ_ψ = hypot(max(heading spread, 3°), 0.1°/m × position spread): the spread along a
    road that bends carries the road heading of another place.
- **After the start** the filter carries on (it holds the turns driven so far). An EKF started by a course,
  alignment or parked pose keeps the filter only if it is `tracking` with its top cluster within 3σ + 30 m and
  3σ_ψ + 30° of the EKF; otherwise the filter restarts around the EKF (known heading). Five satellite fixes failing
  the gate still reset the navigator to `anchored`, and the filter restarts there with the heading unknown.
- **Order:** whichever comes first among GNSS course, alignment and map.
- **Ambiguity:**
  - On a straight road both directions stay alive until a turn, a dead end or the coarse fixes separate them
    (unit test: 400 m mid-road, no start).
  - In a grid, all junctions with the same turn sequence stay alive until fixes or further turns separate them.
    If one of them wins by chance, the start is on the wrong road: see the 52 m start in §8.1.
  - Unimodality is the rule; no extra rule ("needs N turns") is added.
- **The pull-out turn is weighed like any other.** Leaving a parking space turns the car 50–120° within the first
  10–25 m (all 14 drives), and on ka4rza a parallel road's junction turn matched it. Not comparing the turns over
  the first 30 m after a parked start was tried (`replay:bench --jam-start --compass`, 3 seeds): more map starts
  (map alone 28 → 31, with the compass 43 → 45) but more wrong ones: map alone 0 → 1 (j5m8tq from 0 s, 116° and
  302 m off), compass turned 90° 1 → 7, most of them parked starts. The pull-out often is a mapped turn (out of
  a service road or driveway), and it is what lets the roads overrule a wrong alias or compass. Dropped.
- **Tests** (`particle-filter.test.ts`, fixture graph, Wi-Fi-like fixes only while parked): start at a dead end,
  map start within 400 m, heading < 5° off, position within 2 × its accuracy, then the turn onto 162 followed;
  mid-road, both directions alive and no start; no filter while the anchor is coarser than 1 km.

### 8.1 Measured (`npm run replay:bench -- --jam-start`)

Real jammed drives, as recorded (reference: the clean part of the drive, its heading taken back by the gyro):

| Drive | Without map | With map |
| --- | --- | --- |
| q8tfjs (jammed 10 min, parked 7.5 of them) | alignment at 613 s, after 0.64 km, 3.4° off | map at 544 s, after 0.28 km, 2.6° off |
| ng2n9z | alignment at 151 s, after 0.57 km | the same: the filter tracks at 111 s, then flips between `tracking` and `multimodal`, so 100 m are never held |
| vwaz7t (jammed throughout) | never (1.33 km, no fix spread) | map at 420 s, after 0.44 km; no reference (5 of 7 later coarse fixes inside their radius) |

Simulated jams on the clean drives: 35 sessions starting every 60 s, jammed from the session start to the end
(`src/nav/replay/jam.ts`), scored against the ground truth:

| | Starts | Distance to start, median | Heading error median / max | Position error median / max | Error ÷ σ, heading / position (max) |
| --- | --- | --- | --- | --- | --- |
| Without map | alignment 35 | 0.67 km | 3.4° / 11.1° (4 > 10°) | 41 / 67 m | 1.1 / 1.6 |
| With map | map 29, alignment 6 | 0.41 km | 1.0° / 11.1° (2 > 10°) | 21 / 87 m | 1.1 / 5.2 |

- Map starts: heading at most 2.6° off. The two starts over 10° are alignment starts on 6vccgr that the map
  didn't beat, the same as without the map.
- The map starts first in 29 of 35 sessions; in the other 6, alignment starts at the same moment as without it.
- Position: one start is 52 m off along the right road with σ 10 m (q8tfjs from 720 s): a turn-sequence alias
  that won by chance. The later coarse fixes are accepted and pull the EKF back. The along-road spread starts
  (σ up to 150 m) are honest.
- Holding the heading for 50 m instead of 100 m starts a little sooner (median 0.36 km, map 31 of 35) with the
  same accuracy here. 100 m stays until drives beyond Slavutych show grids and parallel roads.

With the 7 drives of 2026-10-04 (65 simulated sessions, after the handling and coarse-repeat changes of
NAVIGATOR-SPEC §4, §5.1):

| | Starts | Distance to start, median | Heading error median / max | Position error median / max | Error ÷ σ, heading / position (max) |
| --- | --- | --- | --- | --- | --- |
| Without map | alignment 63 | 0.64 km | 3.1° / 43.3° (11 > 10°) | 36 / 85 m | 4.9 / 2.3 |
| With map | map 31, alignment 32 | 0.54 km | 1.5° / 20.7° (9 > 10°) | 26 / 87 m | 2.4 / 2.3 |

- All 37 map starts (sessions and drives as recorded) are within 2.3°. Every start over 10° is an alignment start
  that the map didn't beat.
- The map starts first less often on the new drives (10 of 30 sessions against 21 of 35 on the old ones): longer
  straight roads, and alignment no longer restarts at false handling triggers, so it finishes sooner.
- On the 7 old drives the handling change alone took map starts from 29 to 23 of 35 for the same reason, with
  alignment better (position median 41 → 31 m, > 10° starts 4 → 2).
- The real jammed drive of 2026-10-04 (3afby6) never starts, with or without the map: in the app the navigator
  carried over from the previous drive (NAVIGATOR-SPEC §9.1).
- M5's exit (no start > 10° off) holds for map starts. Alignment starts are overconfident (NAVIGATOR-SPEC §13.9).
- **Truth survival** (now measured per session): even without a compass, the true road has no particle for a while
  in 21 of the 30 sessions, at worst 27 % of the moving time (§15.12).

### 8.2 Compass at a jammed start (replay only; NAVIGATOR-SPEC §7.6)

- **Rule:** while the heading is unknown (state `init`), a standing look: at each straight moment each particle's
  compass factor `inlier · N(travel direction − compass; 25°) + (1 − inlier)`, `inlier` = 0.85, replaces the one
  already in its weight (only the change is applied). It stays in force through resampling and follows particles
  that turn; a re-seeded particle starts without it.
  - Not added up, because the compass error is a bias that lasts the drive: applying it every 50 m stacked the
    same error, and a compass turned 180° left the true direction ~1/280 of the weight.
  - Bounded: the best and worst directions differ by at most 1 / (1 − inlier) = 6.7:1.
  - Only from a calibration confirmed on the drive that kept it (NAVIGATOR-SPEC §7.6).
- **Map-start guard:** the start's travel direction (±45°) must also hold ≥ 0.5 of the weight with each particle's
  compass factor divided back out. It never fired in the benchmark (below): by the time a wrong compass has won,
  the particles of the true direction are gone, so the weights without the compass agree with it. Kept as a cheap
  check; the protection is the calibration's validity, not the weight's cap.
- **Measured** (`replay:bench --jam-start --compass`): the 7 drives of 2026-10-04 (30 simulated sessions), each
  with the calibration pooled from the other drives, right and turned 90° / 180°. The filter is random and one
  seed is noisy (single sessions flip between a map and an alignment start), so three seeds (1–3, now the
  default), 90 sessions:

| | Map starts | Distance to start, median | Position error median | Starts > 10° off | Map starts > 10° off | Truth survival min (< 100 %) |
| --- | --- | --- | --- | --- | --- | --- |
| Map, no compass | 28 | 0.60 km | 36 m | 21 | 0 | 73 % (60) |
| + compass | 43 | 0.55 km | 26 m | 17 | 0 | 64 % (49) |
| + compass turned 90° | 31 | 0.56 km | 37 m | 22 | 1 | 15 % (65) |
| + compass turned 180° | 26 | 0.60 km | 39 m | 25 | 2 | 53 % (70) |

  - With the right compass (seed 1) the EKF starts sooner in 12 sessions and later in 1.
  - Wrong starts: turned 90°, 94zf2q from 60 s started 93° wrong and 258 m off (25.8σ); turned 180°, 9qw8wn from
    0 s 102° wrong and 457 m off, j5m8tq from 240 s 10.5° and 189 m off. Each time the true road's particles were
    gone before the start. The right compass gave none.
  - Tried and dropped: one look per filter start (sooner in 6, later in 5, never a wrong start: little gain);
    the compass in the start decision only, not in the weights (the gain gone, and a 180° compass still gave a
    98° wrong start, 216 m off, on 9qw8wn). Stronger looks in the one-look version: with a 180° compass, `inlier`
    0.95 gave a start at 3.5σ, 0.99 one 179° wrong and 612 m off.
- Unit tests (`particle-filter.test.ts`): mid-road on the fixture graph, the right compass gives the true
  direction > 0.7 of the weight (without it, even); turned 180°, the true direction keeps > 0.1.

## 9. Closed loop (PF → EKF)

- **When:** state `tracking`, navigator in `dr`, every 25 m of travel. The interval limits the correlation, because
  the PF itself runs on the EKF's increments.
- **Road heading:**
  - σ = 4° (⊕ the filter's heading spread), only where the road is straight within 3° over ±15 m and not within
    20 m of a node, the filter in `tracking` (≥ 0.9 of the weight on such road) and the car driving straight.
    2° was the first value; it made the EKF overconfident (§9.2).
  - Sent also while GNSS is trusted. It is the candidate fix for the ~2° heading error at outage start
    (NAVIGATOR-SPEC §13.1).
- **Position** (`mapMatchLoop: "closed"`, `roadPositionUpdate`):
  - The dominant cluster's mean, in state `tracking` on a road, at most every 200 m.
  - Its weighted covariance (`MapMatchCluster.covariance`), floored at 12 m along the road and 5 m across it, as a
    full 2×2 measurement (`DrEkf.updatePositionCovariance`). 25 m with 5 / 3 m floors, the first values, made the
    EKF badly overconfident (§9.3).
  - Along the road the floor also grows with the distance since the car last turned (≥ 30° within 50 m): 1 % of it
    (`roadPosition.alongPerM`). Only turns tell where along a road the car is; without this the EKF stayed confident
    on long straights, its prior held the filter's spread, and a turn was matched to the wrong junction (§9.4).
  - **Not sent while GNSS is trusted.** The PF already weighs the same fixes, so sending it would count them twice.
  - **"Trusted" until integrity exists** (SPEC Phase 3): a satellite fix was accepted by the EKF in the last 3 s,
    the rule that makes the app's source `fused` rather than `dr` (NAVIGATOR-SPEC §9). Integrity replaces it.
- Both use the EKF χ² gate (16). A rejection is an app note, not a reset.
- **The EKF-position term of the filter (§7.4)** feeds the EKF back into the filter. Measured with the loop closed
  (25 m updates): scale 0.3 (as now) 13.5 m, 0.1 16.7 m, off 18.6 m 240 s max error median, the truth equally often
  inside the circle. Kept at 0.3. §15.10 and §15.12 stay open: they are about starts, not the loop.
- **Order:** road heading alone first (it targets the heading at outage start, NAVIGATOR-SPEC §13.1, §13.8, and
  adds little double counting: the filter weighs GNSS positions, not courses), then position, then the term above.
- Replay switch: `--nav '{"mapMatchLoop":"open"|"heading"|"closed"}'` (`replay:bench`, `replay:view`'s
  *Navigator*). Open loop = the PF runs and is scored but sends nothing.

### 9.1 Baseline: open loop (2026-10-04, 14 logs, seeds 1–3 pooled)

`npm run replay:bench -- tools/triplog/logs/*.ulg --mm`; what M6 has to beat (§12). Windows × seeds.

| Outage | Windows | EKF max error median / p90 | EKF end error median / p90 | EKF err ÷ σ | Map match max error median / p90 | Map match end error median / p90 | Map match max better |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 60 s | 177 | 11.7 / 34.5 m | 8.8 / 27.0 m | 2.28 | 13.4 / 28.6 m | 6.2 / 13.3 m | 75 of 177 |
| 120 s | 150 | 23.8 / 64.7 m | 19.5 / 56.0 m | 2.25 | 20.6 / 42.0 m | 7.6 / 18.6 m | 92 of 150 |
| 240 s | 108 | 59.3 / 123.7 m | 35.9 / 107.6 m | 2.25 | 40.2 / 77.7 m | 14.1 / 63.9 m | 66 of 108 |

- Err ÷ σ per drive: 94zf2q 4.6–6.0, j5m8tq 2.5–3.5, qfger8 1.6–2.8, the others 0.9–1.9 (NAVIGATOR-SPEC §13.8).
- The map-match end error is a third to a half of the EKF's: turns reset the along-track error, which the EKF
  keeps. That is what closing the loop should hand to the EKF.

### 9.2 Road heading into the EKF (`mapMatchLoop: "heading"`, same logs and seeds)

`npm run replay:bench -- tools/triplog/logs/*.ulg --mm --nav '{"mapMatchLoop":"heading"}'`
(`src/nav/navigator.ts` `roadHeadingUpdate`, `ParticleFilter.roadHeading`). EKF max error median / p90, and max
error ÷ σ, against open loop (§9.1):

| Variant | 60 s | 120 s | 240 s | Err ÷ σ 60 / 120 / 240 s |
| --- | --- | --- | --- | --- |
| Open loop | 11.7 / 34.5 m | 23.8 / 64.7 m | 59.3 / 123.7 m | 2.28 / 2.25 / 2.25 |
| σ 2°, every 25 m | 8.3 / 14.1 m | 12.1 / 18.1 m | 16.8 / 26.0 m | 2.46 / 2.47 / 2.27 |
| **σ 4°, every 25 m (kept)** | 9.1 / 17.1 m | 14.1 / 21.1 m | 21.1 / 32.5 m | 2.10 / 1.97 / 2.16 |
| σ 2°, every 75 m | 8.7 / 14.8 m | 12.9 / 20.1 m | 19.0 / 28.6 m | 2.26 / 2.27 / 2.08 |
| σ 4°, every 75 m | 9.5 / 21.3 m | 14.8 / 27.6 m | 23.0 / 47.1 m | 2.01 / 1.89 / 2.04 |

- Every drive's error falls (240 s: j5m8tq 91 → 26 m, 94zf2q 71 → 24 m, q8tfjs 67 → 21 m). The heading at outage
  start was the limit (NAVIGATOR-SPEC §10, §13.1), and straight roads fix it while GNSS is still good.
- σ 2° counts every update as new evidence, but updates 25 m apart on one road share its geometry error and the
  lane offset: σ_ψ shrank faster than the error. Widening σ fixed that better than spacing the updates.
- Err ÷ σ per drive (σ 4°), open loop → heading: j5m8tq 2.45 / 2.93 / 3.51 → 2.08 / 1.84 / 2.20, 94zf2q 4.6–6.0 →
  3.7–4.0, qfger8 2.80 / 2.52 / 1.61 → 2.50 / 2.45 / 2.08, 5mn7ai 1.91 / 0.95 / 0.86 → 1.42 / 1.64 / 1.09 (it was
  underconfident), 9qw8wn (one window) 2.78 → 2.84. The others fall and stay within 0.5–2.
- The dominant cluster (still open loop for position) now beats the EKF's max error less often (240 s: 39 of 108,
  was 66), but ends closer (10.4 vs 16.1 m): turns fix the along-track error, which the EKF doesn't get yet. That is
  the position pseudo-measurement's job.
- Synthetic drive (`particle-filter.test.ts`): 1.2 km cut on a straight road with an unlearned 0.05 °/s gyro bias,
  heading 2.9° off open loop, 0.2° with the road heading (σ 2°; still < 1° at 4°).

### 9.3 Road position into the EKF (`mapMatchLoop: "closed"`, same logs and seeds)

Max error ÷ σ is the wrong yardstick here. It divides the worst moment of a window by the mean σ: fair while the
error grows through an outage (open loop), but with map corrections the error stays bounded and wanders, and the
worst of many wanders is several σ even when σ is honest. `replay:bench` now also reports **inside circle**: the
share of held-out fixes within the circle the map draws (1.5 σ, the ~68 % radius), honest ≈ 68 %.

| Variant | Max error median / p90: 60 s | 120 s | 240 s | End error median 240 s | Inside circle 60 / 120 / 240 s |
| --- | --- | --- | --- | --- | --- |
| Open loop | 11.7 / 34.5 m | 23.8 / 64.7 m | 59.3 / 123.7 m | 35.9 m | 67 / 69 / 68 % |
| Heading (§9.2) | 9.1 / 17.2 m | 14.2 / 22.0 m | 20.6 / 34.2 m | 14.1 m | 69 / 72 / 77 % |
| + position every 25 m, floors 5 / 3 m | 9.3 / 15.2 m | 11.0 / 20.5 m | 13.5 / 26.3 m | 7.1 m | 26 / 24 / 22 % |
| every 200 m, 8 / 4 m | 9.3 / 16.0 m | 13.3 / 19.0 m | 16.2 / 20.1 m | 6.2 m | 58 / 54 / 58 % |
| **every 200 m, 12 / 5 m (kept)** | 9.0 / 16.3 m | 13.2 / 19.2 m | 17.2 / 20.0 m | 6.9 m | 63 / 61 / 65 % |
| every 150 m, 12 / 6 m | 8.9 / 15.4 m | 13.1 / 18.1 m | 16.7 / 19.8 m | 6.2 m | 63 / 60 / 63 % |
| every 200 m, 10 / 4 m, σ × 1.5 | 9.4 / 16.1 m | 13.2 / 20.0 m | 16.9 / 20.4 m | 6.2 m | 59 / 55 / 59 % |

- Each update every 25 m repeats the same road information, so σ collapsed (2–3 m against errors of ~10 m). Spacing
  them and flooring the covariance fixed it; inflating σ alone didn't.
- Inside circle per drive (kept): 40–94 %. Lowest: 94zf2q 40 / 47 / 59 % (open loop 39 / 40 / 36 %), qfger8 48 / 42 /
  64 % (open loop 58 / 65 / 81 %), j5m8tq 67 / 59 / 56 % (65 / 66 / 62 %).
- The dominant cluster and the EKF now agree: the app's puck rule (the cluster while dead-reckoning, §11) matters
  less with the loop closed.
- **Longer outages** (`--durations 300,480,600`): the error stops growing once the loop is closed.

  | Outage | Windows (drives) | Open loop max / end median | Closed max / end median | Closed max p90 | Inside circle |
  | --- | --- | --- | --- | --- | --- |
  | 300 s | 84 (5) | 90.7 / 43.2 m | 17.5 / 8.9 m | 20.6 m | 66 % |
  | 480 s, 5.6 km | 24 (2: 5mn7ai, j5m8tq) | 93.4 / 35.0 m | 20.0 / 4.3 m | 24.8 m | 64 % |

  No 600 s window has 80 % clean GNSS: the logs are 4–12 min of driving. Hours in a city need longer drives (Cut
  GPS keeps the real fixes in the log as truth) and grids with parallel roads; Slavutych has few.
- Synthetic drive (`particle-filter.test.ts`): GNSS cut 50 s before a junction, unlearned gyro bias, OBD 3 % low; no
  road position with GNSS throughout; with the cut, the EKF ends closer to the truth than open loop, with a smaller
  radius that still covers it.

### 9.4 Hours without GPS: simulated city drives (`npm run replay:sim`)

The logs are 4–12 min of driving in a small town. `src/nav/sim/city-drive.ts` drives a random route on a real road
graph for hours: drivable roads only (not service or private), straight on three times as often as turning, cruise
speed by road class, slowing for turns (2.5 m/s² lateral), stopping at a quarter of the junctions for 5–45 s, pure
pursuit on a line 1.5–3.5 m right of the centre line on two-way roads (±2 m on one-ways) with a slow lateral wander
for map error (σ 1.5 m over 150 m). The phone's sensors come from the truth with the errors measured on the CX-5 and
iPhone 13: gyro bias 0.05 °/s with a random walk of 0.03 °/s per √h, scale 1.007, noise 0.003 rad/s; OBD × 0.981
− 0.23 km/h, rounded, 0 below 2.5 km/h; GNSS errors σ 2.5 m correlated over 30 s. The truth is exact, scored every
second. `tools/replay/simulate.ts` runs it: GPS for the first 3 minutes, then none to the end.

Three 3-hour drives per case (seeds 1–3, IMU 50 Hz; GNSS speed 1.0 s late, as CoreLocation's). Per seed:

| Case | Loop | Dot error median | Max over 3 h | > 50 m of the time |
| --- | --- | --- | --- | --- |
| Chernihiv city (65 km, a turn per 0.3–0.4 km) | open | 8 / 178 / 353 m | 8.0 / 1.8 / 10.6 km | 32 / 66 / 64 % |
| | closed | 4.6 / 4.9 / 4.9 m | 41 / 50 / 35 m | 0 % |
| Kyiv city centre (58 km, a turn per 0.4 km) | open | 89 / 5 / 537 m | 9.9 / 0.2 / 4.5 km | 51 / 2 / 74 % |
| | closed | 4.8 / 5.5 / 4.0 m | 39 / 32 / 54 m | 0 / 0 / 0.2 % |
| Kyiv avenues (`--route arterial`, a turn per 1.8–3.7 km) | open | 4.8 / 4.3 / 3.7 m | 178 / 360 / 104 m | 2 / 2 / 0 % |
| | closed | 3.4 / 4.4 / 4.4 m | 26 / 33 / 21 m | 0 % |
| Chernihiv oblast main roads (`arterial`, a turn per 2.3–10 km, intercity at 70 km/h) | open | 13 / 15 / 3062 m | 23 / 3.6 / 17 km | 40 / 43 / 62 % |
| | closed, fixed along floor | 6.5 / 28 / 3.6 m | 140 / 188 / 48 m | 11 / 41 / 0 % |
| | closed (along floor 1 % since the last turn) | 5.8 / 15 / 3.8 m | 64 / 67 / 48 m | 4 / 9 / 0 % |

- Closed loop holds wherever there are turns: city drives and avenues stay within 4–6 m median and ~50 m worst over
  3 h, every half hour alike. Open loop gets lost on most runs: the EKF drifts hundreds of metres, its position prior
  (§7.4) pulls the filter onto wrong roads, and nothing brings it back without GNSS.
- About 1 road-heading correction per 50 m and 1 road position per 200 m; a few per thousand refused by the gate.
- 30 min drives replay in ~4 s, 3 h in ~20 s (Node, Windows PC).
- **Long roads with few turns** (Chernihiv intercity, seeds 1–2) failed with a fixed along-road floor. Traced
  (`--trace`):
  - The error is along the road (across median 2.2 m): the dot falls behind ~0.15–0.25 % of the distance at
    70 km/h. After an hour of highway it is 110–170 m behind; a turn is then matched to the next junction (the dot
    jumps ahead by twice that), and on one drive the filter later lost the road (2.2 km off).
  - Throughout, the filter reports `tracking` with a tight cluster: confident while 170 m off. Its spread along the
    road doesn't grow with the distance driven, so at the turn there is no alternative at the right junction.
  - Cause of the drift: the speed calibration. 15 min of GNSS mostly in town left the speed at 70 km/h 0.4–0.5 %
    low; the closed loop corrects it at turns (k_s 1.011 → 1.021 over 2 h, truth 1.019) but too slowly for a road
    with a turn every 10 km.
  - Tried, not kept: a speed offset state (NAVIGATOR-SPEC §13.12): the EKF can't separate it from the scale with
    town speeds and GNSS speed (learned 0.5 km/h, truth 0.23); neutral on the 14 logs, mixed here. The filter's
    EKF-position prior at 0.1 or 0 instead of 0.3: fixes one drive (30 → 9 % of the time > 50 m) and breaks
    another (0 → 43 %, 1.7 km).
  - **Kept:** the road position's along-road floor grows by 1 % of the distance since the last turn (§9). On a long
    road the EKF's along σ then grows, its prior no longer holds the filter's spread, and the next turn's shape
    picks the junction. Seeds 1–2: max 140 / 188 → 64 / 67 m, time > 50 m 11 / 41 → 4 / 9 %. 0.3 % helped one seed
    and hurt the other; 0.6 % was in between. City, Kyiv and avenue drives and the 14 logs are unchanged
    (`replay:bench --mm`, closed: 240 s 16.9 vs 17.2 m, inside circle 65 %).
  - **Tried, not kept: a map-free twin EKF** (`mapMatchTwin`, §9.5).
- Next candidates: Wi-Fi/cell fixes during jamming (the simulator gives none; ±50–150 m ones bound along-road drift);
  the speed calibration kept per car across drives (the app does; the simulator starts from 1 ± 0.03 each time).

### 9.5 A map-free twin EKF (tried; `mapMatchTwin`, off)

The navigator can run a second EKF on the same sensors and GNSS that never takes a road correction, so map-matching
mistakes can't reach the filter through the EKF and a wrong-road lock shows as the two disagreeing. Two uses tried
on the simulated drives (3 h, seeds 1–3):

| Filter takes from the twin | Chernihiv intercity: time > 50 m off | Kyiv city: max |
| --- | --- | --- |
| nothing (main EKF, as kept) | 11 / 41 / 0 % | 39 / 32 / 54 m |
| position prior | 39 / 83 / 25 % (up to 66 km) | 478 / 120 / 381 m |
| position prior and odometry | 11 / 49 / 62 % | 483 / 188 / 428 m |

The twin drifts like the open loop (§9.4), and pulling the filter toward it brings back the open loop's failure:
the filter follows a drifting position onto wrong roads. The main EKF's prior is what anchors the filter; its fault
was only claiming to know the position along the road, fixed by the growing floor (§9). Kept, off, for the third
use, not built: a tripwire that stops the road corrections when the corrected track's shape over the last few
hundred metres stops matching the twin's.
- **Optimistic:** the map is the road network the car drives (topology exact, only the geometry wanders), and there
  is no parking, reversing, yard, unmapped road, traffic jam, tunnel or phone handling. Real long drives with Cut GPS
  (NAVIGATOR-SPEC §9) are the check.

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
| Truth survival | Share of moving time at least one particle is on the truth road; target 100 % outside HMM breaks. The only metric that counts state `init` |
| Re-lock time | From entering `multimodal` to `tracking` on the truth road (s and m) |
| Multimodal share | Share of moving time in `multimodal` |
| Position error | Dominant cluster versus held-out fixes, in the `replay:bench` windows (NAVIGATOR-SPEC §10), next to the EKF |
| Heading init | Distance to EKF start, heading and position error at start, and both ÷ the σ it started with (§8.1), versus alignment |
| Update time | PF update p50 / p99 (ms) in Node; on device from the `mm timing` note and `nav_mapmatch` (§11) |
| Inside circle | Share of held-out fixes within the EKF's drawn circle (1.5 σ); honest ≈ 68 % (§9.3) |

**Every one of these is one filter seed.** The particle filter is chaotic: a change that only shifts the random
stream — even an extra draw that is then ignored — sends a 45-minute drive down a different path, and a single
replay of a single drive measures mostly luck. Report a sweep (`--mm '{"seed":N}'`), per seed, not a mean: eight
seeds for a metric aimed at one failure, three to ten for the corpus, three per simulated drive. On the drive of
§15, item 14 one change read as 52 s → 3 s on seed 1 and as worse than before on seed 2.

**And on every drive, not only the one a change is for.** Replay each drive through the app as the viewer does it,
from a cold start and from the parked pose the earlier logs left, and compare drive by drive: an average hides one
drive gone from 15 to 490 m off. Most jammed drives have no satellite fix at all, so every metric above, scored
against GPS, skips exactly them. Two changes measured on their own drive and on these benchmarks were reverted
for that (2026-10-07): §15, item 14, and NAVIGATOR-SPEC §6.1.

### 10.3 Tooling (`tools/replay`)

> **A replay runs what the app runs.** The settings the app ships that differ from the library defaults live in
> `src/nav/app-defaults.ts`, `replayTrip` starts from them, and `services/runtime.ts` reads the same constant, so
> the two cannot drift; `app-defaults.test.ts` fails if a listed default stops differing (it would then be dead)
> or if a replay stops taking them. `--nav '<json>'` still overrides one for an experiment, and `replay:mm` prints
> which loop it ran. This exists because they did drift: `DEFAULT_NAV_CONFIG.mapMatchLoop` is `open` and the app
> has shipped `closed` since the switch was added, so every replay measured a different filter from the one in the
> car — on 2026-10-06 the phone's dot drove through a field for 52 s at 130 km/h while the open-loop replay of
> that same log never left the road, which made the bug look unreproducible and its fix look worthless (§15,
> item 14). Anything else the app turns on by default belongs in that file.

- `npm run replay:mm -- [--graph <file>] [--cut s:len]… [--open-loop] [--mm '<json config>'] [--trace from:to] <logs>`
  (M4): the §10.2 metrics per drive, wrong-road and lost stretches, update time, filter vs EKF error in cuts;
  `--trace` prints per second the state, top clusters (OSM way, weight, spread), the true way, both errors.
- `npm run replay:bench -- --mm [--mm-config '<json>']` (M4): the outage benchmark with the filter's columns.
- `npm run replay:bench -- --jam-start [--every 60] [--verbose]` (M5): §8.1. Each drive as recorded, and clean ones as
  sessions every 60 s jammed from their start; each without and with the map. Reference: the truth, else a clean
  replay's EKF, else its later heading taken back by the gyro.
- Both run the filter with 3 seeds by default (`--seeds N`) and pool them: with one seed, single sessions flip
  between a map and an alignment start from one seed to the next (§8.2). With the map the EKF's columns vary by
  seed too (a map start sets its pose). Numbers measured before 2026-10-04 are one seed.
- `replay`, `replay:mm`: `--app-cuts` cuts where the app simulated an outage (NAVIGATOR-SPEC §9).
- `replay:mm`, `replay:view`: `--start <s>` / *start* begins the session that far into the log; `--jam
  start:len|inf` / *jam* simulates jamming (M5).
- `npm run replay:truth -- [--graph <file>] [--json <out>] <logs>` (M3): chains, breaks with their reason and place,
  moving-fix distance to the road, route vs OBD vs navigator odometry, legs that don't fit, penalised legs.

- `npm run replay:graph -- [--graph <file>] <logs>` (M2): fix-to-road distance, course vs road heading, reader
  timing (§5.1).
- Graph choice: `--graph <file>`, else the smallest `tools/tiles/out/release/*.graph.bin` with roads at the trip's
  first fix (the oblast rather than Ukraine).
- `replay --graph <file>` loads a graph through the Node `ByteSource`. Without one, replay behaves as today.
- `--mm off|open|closed` (default `open` with a graph): M6.
- `--jam start:len` (done in M5, `src/nav/replay/jam.ts`):
  - satellite fixes in the window become coarse ones: no speed or course, an Ornstein–Uhlenbeck error (σ 45 m per
    axis, correlation 120 s: median 53 m), reported `h_acc` 65 m;
  - one every 5–10 s, 30 % repeating the previous position. Coarse fixes the log already has stay.
- **Viewer layers:**
  - graph edges, colored by class, one-ways marked (done in M2: roads around the trip's fixes, junction, dead-end
    and boundary nodes at zoom ≥ 15, hover for way id, class, length, flags; `replay:view -- --graph <file>`);
  - truth route (done in M3: the matched route, the leg at the cursor thick, breaks as × with their reason on hover);
  - the particle cloud at the cursor time, and clusters with their weights (done in M4: particles once a second,
    200 heaviest, size by weight; clusters as rings sized by spread, labelled with weight and state; from M5 also
    while anchored).
- **Logs:** all 14 current logs are from Slavutych, a small planned town. Parallel-road and dense-grid cases (SPEC §7.5)
  need drives elsewhere: Kyiv, or Chernihiv's ring roads. Record some before calling M5 done.

### 10.4 Measured (M3, `npm run replay:truth`)

| Drive | Clean fixes matched | Moving fix → road (median / p95) | Route / OBD / odometry | Breaks |
| --- | --- | --- | --- | --- |
| q8tfjs | 402 of 422 | 2.1 / 6.0 m | 2.98 / 2.87 / 2.94 km | 1: off the graph (at the end, 20 fixes: most likely the driver walking off with the phone, see below) |
| 5mn7ai | 656 of 672 | 3.2 / 6.4 m | 3.32 / 3.27 / 3.34 km | 1: off the graph (yard, 16 fixes) |
| 6vccgr | 196 of 196 | 2.2 / 7.5 m | 1.18 / 1.12 / 1.14 km | 2: gaps of 30 and 38 s, fixes 11–27 m |
| s4fkdm | 308 of 308 | 1.8 / 4.8 m | 1.05 / 1.01 / 1.01 km | none |
| 79xky3 | 45 of 45 | 2.0 / 2.7 m | 0.51 / 0.47 / 0.48 km | none |

- No `no route` break on any drive. Every break was checked on a map: two are the car driving off the graph into
  an unmapped yard, two are stretches of degraded GNSS.
- Revisited after the 2026-10-04 drives: at the end of q8tfjs the phone is handled (gravity swinging ~100°), GNSS
  moves at 6–7 km/h and OBD reads 0, then nothing. That is the driver walking off with the phone, as on two of the
  new drives, rather than the car in a yard. The new drives' walks show up the same way (9qw8wn: a 31-fix break,
  route 149 % of the OBD distance).
- Routes are 1–7 % longer than OBD: OBD reads ~2 % low on the CX-5 (NAVIGATOR-SPEC §5.2), and the centre line is
  not the driven line. The navigator's odometry (`k_s` learned) is 0.7 % above to 5.4 % below the route.
- Of 725 moving legs, one doesn't fit its OBD distance (a 1 s fix jump). No leg needed a penalty.
- 7–64 ms per drive in Node.

## 11. App

- **Downloads** (`src/services/offline-map/map-packs.ts`): fetches `graph` after the region's `.pmtiles`, with the
  same size and MD5 checks, into `Documents/maps/<region>.graph.bin`. In the foreground and not pausable (an
  oblast's graph is 10–40 MB). Regions downloaded before this change show "Update available" and fetch only the
  graph. The active map's card says when it has no road data yet.
- **NavigatorService:**
  - opens the active region's graph (`src/services/offline-map/road-graph-file.ts`: a `FileHandle` `ByteSource`,
    §5) and passes the `RoadGraph` to the navigator;
  - a change of active region or graph version restarts the PF (`mm graph <region>` / `mm graph none`);
  - without a graph, `mapMatch` is absent and everything works as today.
  - **Puck:** the dominant hypothesis only while the position source is `dr` (no recent trusted satellite fix),
    with radius max(spread, 5 m). With GNSS the EKF stays the puck: it is within a few metres there (NAVIGATOR-SPEC
    §9.1), and the filter's position was measured only in outages (§7.7). This narrows §6.2. Alternatives (weight
    ≥ 0.05) are drawn in state `multimodal`.
  - **On a road while it drives:** in state `offroad` at 15 km/h or more, the dominant hypothesis is drawn at the
    nearest point of a road it could be driving along — within 80 m, its heading within 60°, not against a one-way
    (`MapMatchEstimate.clusters[0].road`, `position/puck.ts`) — and as it is when there is none. Off the roads a car
    only parks, and nobody parks at 15 km/h; a dot crossing a block at city speed is wrong whichever road is right.
    The filter keeps its off-road hypothesis — following the car's own path off the map is how it finds the road
    again — so only the drawing changes, and the trip log's `nav_mapmatch` still records the hypothesis itself.
    Over the nine trips of 2026-10-06 replayed through the app (16 filter seeds), the drawn dot more than 15 m from
    every road while the car drives over 15 km/h: median 16 → 2 s a day, none at all on 8 seeds (2 before), worst
    227 → 149 s — the worst are the seeds where the filter has lost the car by more than the reach. On real drives
    jammed after the start the dot is > 50 m off 4.0 → 3.4 % of the time; the simulated drives, which never leave a
    road, are unchanged.
    - Tried, not kept: *forbidding off-road from 10–20 km/h in the filter* instead of 20–40 km/h. It also kept the
      dot on the roads of the real day, and lost the city simulations (time > 50 m off 0.1 → 5.5 %, one run in
      twelve 30 % of its time): off-road particles are the filter's way back from a wrong road, and at 20 km/h it
      snapped them onto parallel streets of the block.
- **Trip log:** ULog message `nav_mapmatch` (TRIP-LOGGER-SPEC §6.3), published with each `nav_estimate` (~2–3
  Hz) while the filter runs:
  - state, particle count, cluster count;
  - top 3 clusters (weight, lat, lon, heading, spread);
  - update µs and graph version (the file's build time);
  - every filter update since the previous record: count, total µs and the slowest. The filter updates 5–10 times
    a second and a record goes out 2–3 times, so the last update's time alone would miss the spikes.
- **Update time on the phone** (§14.5): `NavigatorService` drains the filter's update times at each published
  position into a per-drive histogram (`src/nav/mapmatch/update-timing.ts`, buckets 5 % apart). The Vehicle
  sheet shows p50 / p99, the slowest, how many exceeded 5 ms (red once 100 updates make p99 meaningful), the
  filter's starts and the share of the time spent; at engine off a note `mm timing: <n> updates, p50 … ms, p99 …
  ms, max … ms, … % of the time, <k> over 5 ms; <s> starts, slowest … ms` closes the drive. Starts are kept apart
  from updates (`ParticleFilter.startTimes`): a start lays particles on every road around the car, and the first
  one reads those roads from storage, so it would otherwise stand as the drive's slowest update.
  `tools/triplog` sums the records (`summary()["map_match_timing"]`).

  Read by `readTripLog` (`navMapMatch`) and `tools/triplog` (`Trip.map_match`). App notes: `mm graph …`, `mm
  <state>` on each change except flips between `tracking` and `multimodal` (those are in `nav_mapmatch`), `nav
  mode dr (map)`; pseudo-measurement rejections come with M6.
- **Parked pose:** stays position + heading. Edge ids change between graph versions; the PF snaps onto the graph
  at start.
- **Map:** the dominant hypothesis as the puck and alternatives as hollow markers, fainter the lighter they are
  (§6.2). The Vehicle sheet's diagnostics show the graph's region, state, particle count, hypothesis weights and
  update time. Developer settings → "Map matching on the map (particles)" draws the 200 heaviest particles (size
  by weight, amber off-road) and each hypothesis as a dashed ring of its spread labelled with its weight. They
  are the navigator's state ~300 ms back, not extrapolated like the puck.
- **Navigator version** (Developer settings, `mapMatchLoop`, §9): default *Full correction* (`closed`); *Open loop*
  and *Road heading* for comparing on the road. Applied to the running navigator at once. The trip log header records
  the version a drive started with (`nav_mapmatch_loop`), a change is the note `nav map-match loop <v>`, and at engine off
  `mm loop <v>: road heading N (k refused), road position M (k refused)`. The Vehicle sheet shows the counts live.
  `replay:view` replays a drive with the phone's version by default.

## 12. Milestones

| # | Milestone | Exit |
| --- | --- | --- |
| M1 | Graph builder (§4) | `chernihiv` and `ukraine` built; size, build time and peak memory recorded here; pytest green. **Done** (§4.7) |
| M2 | Reader + viewer layer (§5, §10.3) | TS round-trip tests on a fixture; graph drawn over the drives in `replay:view` and checked by eye; tile load time in Node. **Done** (§5.1) |
| M3 | Odometry output + ground truth (§6.1, §10.1) | odometry chunks sum to the EKF's distance and heading change; truth edge sequences for the 4 clean drives with no unexplained breaks. **Done** (§10.4) |
| M4 | PF open loop, known heading (§7) | §10.2 metrics on all drives; dominant-cluster max error on 240 s cuts better than the EKF's 37 m median; truth survival 100 %. **Done** (§7.7): 30.5 m; survival 100 % except 2 s leaving a yard |
| M5 | Heading init from the map (§8) | EKF starts sooner than alignment on the jammed drives and on `--jam-start`, with no start > 10° off. **Done in replay** (§8.1): sooner on 2 of 3 jammed drives (the third as soon) and 29 of 35 simulated sessions; map starts ≤ 2.6° off. To confirm on drives beyond Slavutych |
| M6 | Closed loop (§9) | `replay:bench --mm` closed against open loop on the same windows and seeds: EKF max error better at 120 / 240 s (median and p90), no worse at 60 s; the truth inside the drawn circle 60–85 % of the time pooled, and no drive below 40 % unless open loop already was (max error ÷ σ misjudges a bounded error, §9.3). **Done in replay** (§9.2, §9.3): 240 s max error 59 → 17 m, p90 124 → 20 m; inside 61–65 %, lowest drive 40 % (94zf2q, open loop 36–40 %) |
| M7 | App (§11) | graph download, `nav_mapmatch` in trip logs, alternatives on the map, update time on iPhone < 5 ms p99. **Built** (§2): needs a drive for the update time |

M1–M3 can partly overlap. M4 needs M1–M3. M5 and M6 are independent of each other.

## 13. Starting values (tune in replay)

| Value | Start | Notes |
| --- | --- | --- |
| `N_track` / `N_max` | 500 / 4000 | §7.2, §7.5; unknown heading: 1 per 10 m of road and direction |
| Odometry chunk | 2 m or 0.2 s | §6.1 |
| Weight interval | 10 m | §7.4 |
| Straight moment / forced comparison | < 8° over 10 m / after 20 m, or at a halt | §7.4 |
| σ_road, turn tolerance | 5°, 10 % of the turn (30 % forced) | OSM geometry, corner cutting |
| Lane dead zone / lane σ | 3 m / 2 m | §7.4 |
| Fix spacing (satellite / coarse) | 10 m / 25 m | correlated errors |
| Coarse-fix σ inflation | × 2 | correlated errors |
| Absolute heading | EKF σ_ψ × 3, scale 0.3 | §7.4 |
| EKF position prior | σ = max(2σ, 10 m), scale 0.3 | open loop only (§9) |
| Off-road penalty | × 0.5 per 10 m, exponent × 1 → 12 from 20 to 40 km/h (not in `init`) | §7.4 |
| On-road floor while off-road | 10 %, projection ≤ 15 m, ≤ 30° | §7.5 |
| At road speed (≥ 40 km/h) | no off-road particles; all projected, ≤ 45 m (`onRoadRecoverProjectM`) | §7.5 |
| `dks` prior / jitter | 0.02 / 0.002 | per-particle distance scale |
| Off-road share / re-injection | 5 % / 2 % | §7.5 |
| Stale off-road resampling | off-road weight < 10⁻⁵ | §7.5 |
| Re-seeding while the heading is unknown | 5 % per resampling | §7.5 |
| Soft-rule factors | §7.3 table | |
| Cluster radius / heading | 30 m / 45° | §7.6 |
| `tracking` threshold | top ≥ 0.9, spread ≤ 25 m | §7.6 |
| Map heading init | settled over 100 m (`tracking`, or one direction ≥ 0.9 with ≤ 10° / ≤ 150 m spread); straight car and road (±15 m + spread, 5°); anchor radius 3σ + distance, ≤ 1 km | §8 |
| Map start σ | position max(spread, 10 m); heading hypot(max(spread, 3°), 0.1°/m × spread) | §8 |
| Pseudo-measurement interval / heading σ | 25 m / 4° (2° was overconfident) | §9.2 |
| Road position interval / floors along, across | 200 m / 12 m, 5 m (25 m / 5, 3 m was overconfident) | §9.3 |
| Road position along floor growth | 1 % of the distance since the last turn (≥ 30° within 50 m) | §9.4 |
| Tile cache / working-set margin | 128 tiles / 300 m | §5 |

## 14. Verification targets

1. Wrong-road rate, truth survival, re-lock time and update time are reported for every drive (§10.2). Pass/fail
   thresholds are set after M4's first numbers. Truth survival is 100 % from the start.
2. `replay:bench` with `--mm closed` is no worse than open loop at 60 s and better at 120 / 240 s, without raising
   max error ÷ σ (§12, M6).
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
   are a first guess. In the simulated jams (§8.1) the one wrong-place start was a turn-sequence alias along the
   right road, not a coarse-fix lock; Slavutych has few parallel roads.
4. Via-way restrictions, ferries and street names are not in v1.
5. Test drives beyond Slavutych for parallel roads and dense grids (§10.3).
6. Spoofing replay (NAVIGATOR-SPEC §13.6) is needed before integrity can use the clusters.
7. **Reversing.** The CX-5 reads OBD 0 while reversing (VEHICLE-LINK-SPEC §10.4), so the particles stand still
   while the gyro turns them: they rotate in place and lose the 5–15 m driven. It costs most in yards (§7.7). OBD
   0 with the gyro turning and the phone steady in the mount marks a reverse; PID `A4` (gear) could confirm it.
8. **Low-speed manoeuvring** decides road vs off-road 20–30 m late; the 120 s p90 is worse than the EKF's because
   of it. More drives with parking and yards are needed before tuning further.
9. **Device timing:** 500 particles take < 1 ms p99 in Node; measure on the iPhone (M7). An unknown-heading start
   with a large anchor uses up to 4000 particles until it tracks. First reading (2026-10-05, parked at home):
   the first start took 48 ms (reading the roads from storage; 2–5 ms cold in Node), the one fix update 0.28 ms,
   as in Node (0.34 ms for the same step). On the 2026-10-05 drives (8 logs with `nav_mapmatch`, 500 particles):
   **~8 ms per update** (median of the per-second averages; p99 41 ms), the slowest single update 143 ms, ~25 ms
   with 2,000 particles at an unknown-heading start. About 10× Node, so the < 1 ms from replay doesn't carry over to
   the phone's JS engine. At 2–3 updates a second the map stays smooth, but the spikes can drop frames. Next:
   profile one drive's updates on the phone (weighting vs resampling vs tile reads) before cutting particles. Still
   needed: a drive that starts without GPS (3afby6's case).
10. **The EKF-position prior after a map start** is the filter's own mean, fed back to it (the same issue as §9 in
    open loop). Decide in M6.
11. **Flip-flopping starts** (ng2n9z): a filter alternating between `tracking` and `multimodal` never holds 100 m.
    A start criterion on the share of the last 100 m, rather than all of it, may help; needs more jammed drives.
12. **Truth lost at jammed starts:** in 21 of 30 simulated sessions on the 2026-10-04 drives the true road had no
    particle for a while (§8.1). Looked at (sessions every 60 s, `--trace`):
    - Most are 1–8 s gaps at junctions, where the particles are a few metres behind the truth edge (the 15 m
      junction tolerance of `isSameRoad` doesn't cover a turn taken early): harmless, the filter recovers.
    - The real losses (94zf2q from 0 s and 120 s: 25–30 s, survival 73–80 %; j5m8tq from 300 s: 19 s) start after an
      alignment start whose position is 40–80 m off: the EKF-position prior (§7.4, scale 0.3) then pulls the filter
      onto the wrong road. 94zf2q from 120 s: survival 73 → 94 % with the prior off.
    - Gating the prior on the EKF's σ (≤ 15 m) fixed those but made others worse (j5m8tq from 60 s: 99 → 79 %: with
      the prior off, a wrong road wins by a turn-sequence alias and the filter tracks it at 100 % until a fix says
      otherwise), so overall it is a wash (outage benchmark 240 s p90 77 → 72 m; sessions below 100 %: 21 → 23 of
      30). Not kept. Same cause as item 10; it needs a better position prior after a start from coarse fixes, or
      fixes that can unseat a confident wrong lock.
13. **Jammed from the start, the EKF pull locks the filter off-road** (2026-10-05, CX-5 across town from the
    parked pose, Wi-Fi fixes only). Replayed with the app's closed loop: off-road 73 % of the moving time, end 86 m
    from where the car stopped; with `ekfPositionScale` 0: 4 %, 20 m. Wi-Fi fixes (often hundreds of metres off)
    move the EKF, and the pull drags the filter after it; on the phone the off-road dot crossed five streets away
    from junctions on that drive. The pull is worth keeping where GPS was good before a cut (`replay:bench --mm`,
    14 logs: 240 s max error median 22 → 29 m, p90 37 → 49 m without it), and weakening it only while no satellite
    fix has come since the start was worse on the jammed drives (`replay:places`: up to 845 m off). **Mitigated by
    the off-road speed rule (§7.4):** the drives that went off-road did so at road speed, which no yard sees. Tried
    and not kept:
    - *A penalty for off-road particles crossing a road away from a junction* (`road-crossing.ts`): no real path
      does it (`replay:crossings`, 4,176 clean fixes on 12 drives: 0 crossings once bridges are excluded), but on
      top of the speed rule it didn't pay. ×0.1 per crossing: jammed from the start wrong road 10.3 → 17.4 %;
      ×0.01: 8.8 %, but one jammed drive ended 852 m off (runs > 50 m 1/30 → 5/30). Particles crushed by it fall
      below the stale off-road threshold, and the resampling that follows reshuffles the hypotheses. It also checks
      every off-road particle's step against the roads around it: update p99 7.9 → 93–178 ms. The speed rule
      already took the off-road cluster's crossings on the jammed drives from 4 to 0.
    - *Road class by speed* (the speed limit, which the graph doesn't hold; most city streets are 50 km/h anyway).
      Real speeds on the clean drives' matched roads (OBD, 1 h of driving): service p99 25 / max 26 km/h,
      unclassified max 30, residential p99 47 / max 51, tertiary max 73, primary max 77. So only "faster than this
      class ever sees" could work (service above ~35, residential above ~60), like the off-road rule. With the
      speed rule, the wrong guesses jammed from the start are on a service road at ≥ 30 km/h 0.5 % of the moving
      time, a residential one at ≥ 45 km/h 0.02 %; nearly all the rest are below 30 km/h, where speed tells
      nothing. Revisit if a drive shows the dot on a yard lane at road speed.
14. **Off-road at road speed after a turn the filter can't place** (2026-10-06, 16 km into a jammed 58 km
    intercity drive, gc6xib). The car slowed 126 → 13 km/h, turned 95° left (gyro 94.5°, peak 43 °/s — the route's own
    manoeuvre #6, −95.1°) and accelerated back to 130 km/h. The filter was `on` the route at 15,891 m with the
    junction 62 m ahead: 0.4 % along-track error over 16 km of pure dead reckoning, and still more than a junction
    can absorb. The off-road hypothesis won at 37–40 km/h and held > 50 % of the weight for 43 s (`clusters` 1,
    `weight_0` 1.00 for 6 s of it) while the car accelerated to 130 km/h, recovering only where the geometry
    agreed again ~1 km along the new road. Guidance froze (`along_m` stuck at 15,891, `off_m` 82–95 m) and four
    re-plans went out in 31 s (now stopped: ROUTING-SPEC §8.2).

    Two causes, and only the first is about off-road. **The off-road penalty is relative:** `logw +=
    offRoadPenalty` lands on off-road particles only, so it needs on-road particles within reach of a road for the
    weight to move to. With the cloud 82–95 m out and `keepOnRoad` reaching `onRoadProjectM` (15 m) there were
    none, the penalty spread over the off-road particles alone, and normalisation cancels a constant added to
    every log-weight; whenever it did bite, the off-road weight fell below `offRoadMinWeight` and the resampling
    that follows reset every weight to uniform. **Nothing could correct the position along the road:** a particle
    turns only at the junction it is standing on, so with the whole cloud short of the junction there was no
    particle at it to reward, and the turn contradicted every hypothesis at once.

    It reproduces on the drive itself, but only with the replay running what the app runs (§10.3): under the open
    loop the filter never leaves the road here and the failure is invisible. `replay:offroad` on that log shows 52
    samples off-road above 40 km/h in one 52 s run — the only such stretch in every log kept (52 of 5 998 samples
    above 40 km/h; every other drive is at 0).

    **Fixed across the road** by §7.5: at or above `offRoadSpeed.fullMps` the off-road hypothesis is not a
    hypothesis — no yard is driven at 40 km/h — so the filter keeps no off-road population there and `keepOnRoad`
    puts every off-road particle back on the nearest aligned road within `onRoadRecoverProjectM` (45 m). The
    penalty alone cannot do that, for the reason above. Off-road above 40 km/h on the drive: 52 s → **0 s**.
    `offRoadSpeed.factor` 1 turns this off with the rest of the speed evidence.

    **Still open: the position along the road,** and the junction test below holds that open. The dot stays on a
    road and picks the wrong one: it takes 36 s to find the road the car turned onto, and at 62 m of along-track
    error on the fixture it ends off the map, because no particle was at the junction when the car turned there,
    and no reach *across* to a road can say where along it the car is.

    Tried and not kept:
    - *Weighing the EKF position along the road once instead of at every weighting, with clusters reaching 150 m
      along the road and `tracking` judged on the spread across it.* Approaching the junction the cloud along the
      road was ±9–14 m against the EKF's own ±25–28 m, so a junction 62 m off had no particle near it. It settled
      this junction in 1–4 s on 8 of 8 seeds started from the parked pose (was 40–52 s on 5), and simulated
      intercity drives spent 1.5 % of the time > 50 m off instead of 9.4 %. It broke the drives with no satellite
      fix at all, which no benchmark scored (§10.2): this drive started cold left its road halfway on 2 of 3
      seeds (the dot's median distance to the drive's Wi-Fi fixes ≈ 330 m, against ≈ 30 m), two jammed town drives
      went 346 and 486 m off on one seed each, and off-road time above 20 km/h over those drives rose 991 →
      1 623 s. Reverted 2026-10-07.
    - *Moving particles to the junction a sharp turn names* (a ≥ 70° turn matched to the one junction within reach
      that turns as much; half the contradicted particles moved there). It settled this junction in 1 s, and
      elsewhere it fires on the wrong junction: replayed without a parked pose, 4 of 8 seeds of this drive ended
      1–20 km off, and on the simulated drives it changed nothing.
    - *A wider reach across to a road* (80–150 m). It fixes this case and costs wrong road 8.5 → 25.6 % on the real
      drives: the reach is across to a road, the error was along one.
    - *Re-injecting particles only in the cluster's own direction* (there were particles driving the approach
      backwards, a U-turn at 130 km/h on the map). It removed the U-turn and nothing else.
    - *Restarting the filter around the EKF when the EKF refuses its road position twice in a row.* It rescued a
      simulated drive where the filter had followed a side road, and lost this real one twice in 8 seeds, where the
      EKF was the one that was wrong. Re-seeding a fifth of the particles there instead was neutral.

    The fixture junction the test uses is shaped on the real one, read off the region graph with
    `replay:junction`: within 150 m of the node sit the approach, **two** primaries leaving eastbound within a few
    degrees of each other, a service road at 134°, and a service lane 45 m to the side — five candidates for one
    95° turn, where the fixture's other junctions offer one exit per direction and survive along-track errors this
    one does not. The offset is injected as the drive had it, a parked-pose start displaced along the approach
    with no fix ever arriving; `obdScale` cannot stand in for it, because the navigator learns the speed scale and
    calibrates it away.
