# wtf.ai — UI Specification

Status: v2 (2026-10-10). The screens and the map as built. Companion to [SPEC.md](SPEC.md) §3.9. Source of truth for
coding agents working on the UI.

## 1. Goal

A map-first app a driver can use with one glance and one tap while the car moves: the position and how far to trust
it, the route, and the car's connection; everything else one level down.

## 2. Decisions

| Topic      | Decision |
| ---------- | -------- |
| Builds     | Dev and release builds from CI, sideloaded (SPEC §2). MapLibre does not run in Expo Go. |
| Map tiles  | OpenFreeMap **Liberty** style on offline PMTiles of the active downloaded region (SPEC §3.8); no online map. |
| Navigation | **Map-first**: full-screen map with floating controls; everything else is a page pushed on one root stack (§5). |
| Design     | **Calm** (claude.ai/design project "wtf.ai Redesign", option 1b): Onest type, frosted-glass map panels (`expo-blur` + translucent tint, `src/components/ui/glass-fill.tsx`), sentence-case trust status, a big light speed numeral. Tokens in `src/constants/theme.ts` (`usePalette()`), icons in `src/components/ui/icon.tsx` (Material names → SF Symbols / Material Symbols). |
| Language   | English + Ukrainian. Default: the first device language the app speaks, Russian as Ukrainian (iOS and Android); override in Settings. |
| Theme      | System light/dark, or a fixed one from Settings (`Appearance.setColorScheme`, persisted); the map style switches too. |
| Units      | SI internally (m, s, rad, m/s). Convert to km/h, km/m, degrees only in UI. |
| Privacy    | Offline map only: no map requests while driving or browsing. GitHub is contacted for the catalog and downloads only. |

## 3. Position source

The map's position comes from `NavigatorService` ([NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) §9), the runtime's
`PositionSource`; without OBD speed it shows phone GNSS (§4.3). GNSS comes from `modules/sensor-capture` (shared with
the trip log), never `expo-location`'s watcher, which stopped for good after jamming.

## 4. Foundations

### 4.1 Position types — `src/nav/position/types.ts` (pure TS)

- `TrustState`: `'TRUSTED' | 'UNTRUSTED' | 'REACQUIRING' | 'NO_FIX'`
- `PositionSourceKind`: `'gnss' | 'fused' | 'dr' | 'manual'`
- `PositionEstimate`:
  - `lat`, `lon` (deg, WGS84)
  - `headingRad?`, `speedMps?`
  - `accuracyM`
  - `source: PositionSourceKind`, `trust: TrustState`
  - `timestamp` (ms)
  - `lastTrustedFixAt?`, `distanceSinceTrustedM?`
  - `rawGnss?` — raw fix for the ghost marker (lat, lon, accuracyM, timestamp)

### 4.2 Geo helpers — `src/nav/geo/` (pure TS)

- `haversineM(a, b)`, `bearingRad(a, b)`, `circlePolygon(center, radiusM, steps)` → GeoJSON Polygon, and the rest of
  the geometry the map draws.

### 4.3 Position service — `src/services/position/` (may import Expo)

- `PositionSource` interface: `start()`, `stop()`, `subscribe(listener) → unsubscribe`, `getSnapshot()`, permission status.
- Phone GNSS (`gnss-position-source.ts`, used by `NavigatorService` without OBD speed):
  - **Fixes:** from `SensorService` (`modules/sensor-capture`: `BestForNavigation`, automotive, never paused by iOS).
    `NavigatorService` registers as capture owner `navigator` while the map is on screen or a trip records.
  - **Mapping:** `GnssRecord` → `PositionEstimate` with `source: 'gnss'`; course → `headingRad`. Invalid
    speed/course (NaN) → undefined.
  - **Trust:** GNSS integrity's (SPEC §3.3, NAVIGATOR-SPEC §8, `src/nav/integrity/integrity.ts`), the same with or
    without an adapter. Decided over time, not per fix, so intermittent jamming doesn't flicker it.
    - Only **satellite fixes** (they have a speed) that integrity passed count as good. Wi-Fi/cell fallback fixes
      never do, however accurate they claim to be (±7 m is common).
    - `'TRUSTED'` → `'NO_FIX'` when no good satellite fix ≤ 50 m has arrived for 8 s.
    - `'NO_FIX'` → `'TRUSTED'` after good satellite fixes ≤ 30 m have kept arriving for 5 s with no gap.
    - `'UNTRUSTED'` while integrity refuses the fixes (abroad, a jump, not moving like the car), `'REACQUIRING'`
      once they come back to the dead reckoning or while a fix after a gap is being checked.
    - The map shows a fix once the navigator has taken it (300 ms after delivery); a refused one only as the ghost,
      while the last good fix is held with a growing circle.
    - Coarse fixes are still shown and don't advance `lastTrustedFixAt`. Transient location errors don't change
      trust.
  - **Logging:** trust changes go into the trip log (TRIP-LOGGER-SPEC §6.4).
- Unit-test the mapping and the trust rules.

### 4.4 React binding — `src/providers/position-provider.tsx`

- Context holding the active `PositionSource`.
- `usePosition()` via `useSyncExternalStore`; `usePositionPermission()` (status + request).

### 4.5 i18n — `src/i18n/`

- `en.ts` — typed source of truth (`Strings` type).
- `uk.ts` — `satisfies Strings` (missing keys fail typecheck).
- `useT()` hook; locale from `expo-localization`; override (`system | en | uk`) persisted in `expo-sqlite/kv-store`.
- No hardcoded user-facing strings in components.

### 4.6 Theme and map config

- `src/constants/theme.ts`: light and dark palettes (`bg`, `text`, `accent`, `route`, `routeAlt`, status colours
  `ok` / `warn` / `bad` / `idle`, …), `usePalette()`.
- `src/config/map.ts`: the active region's offline style (`useMapStyle(scheme)`, `hasUsableMap`); `map-dark.ts` re-tints
  the Liberty style for the dark scheme.

## 5. App shell

- `src/app/_layout.tsx`: `Stack` inside `ThemeProvider` → `I18nProvider` → `PositionProvider` → `RuntimeProvider`
  (`src/services/runtime.ts` creates the services once for the app's lifetime).
- **Pages, not sheets:** everything opened from the map (Route, Vehicle, Offline maps, More and what it opens, the
  Guide and its lessons, the developer pages) is a page pushed on the one root stack, sliding in from the right, so
  going back is the system's: the swipe from the left edge on iOS, the back gesture or button on Android. The page
  header (`ScreenContent`) has a back button, and from the second level down a ✕ straight back to the map. (A form
  sheet can't hold a stack, and iOS has no back swipe for a sheet.)
- **Full-screen modals**, with nothing to go back to: `onboarding` (welcome → location → adapter → phone holder; shown
  until `onboarding-done` is set in kv-store) and `map-setup` (the first map download).

## 6. Map screen (`src/app/index.tsx`)

### 6.1 Map

- Full-screen MapLibre map, the active offline region's style (`useMapStyle(scheme)`, `src/config/map.ts`; the dark scheme re-tints it, `map-dark.ts`). Read the MapLibre RN docs for the installed version before coding (the API changed between majors).
- **Custom puck** from `usePosition()` via GeoJSON source + layers: dot + heading arrow (arrow only when heading known) + accuracy circle (`circlePolygon`). Do **not** use MapLibre's built-in user location — it bypasses the abstraction.
- **Compass beam** (display-only, `useCompassHeading`): when not in a car (no trip recording, adapter not connected) and speed < 3 m/s, a wide faint sector from `watchHeadingAsync` replaces the course cone and shows where the phone points. Half-width = iOS compass uncertainty (20°/35°/50°/60° for accuracy 3–0). The compass runs only while allowed and never reaches `PositionEstimate`.
- Raw GNSS **ghost marker** from `rawGnss`; hidden while `source === 'gnss'`.
- **Map-match alternatives** from `alternatives` (other roads the car may be on, MAPMATCH-SPEC §11): hollow
  markers under the puck, more opaque the heavier they are.
- **Test tools** (Developer settings, off by default): the map-matching particle overlay (MAPMATCH-SPEC §11) and a
  "Cut GPS" chip that simulates a GNSS outage; while it is on, a card replaces the trust alert with the time,
  distance, the dot's distance from the withheld GPS fix and "Restore GPS" (NAVIGATOR-SPEC §9).
- **Navigate without an adapter** (Developer settings, off by default; experimental): with no OBD speed and GNSS not
  trusted, the dot is the phone's own dead reckoning (NAVIGATOR-SPEC §9.6), drawn as `dr` with its alternatives.
  The driver keeps it right by putting the car on the map while it stands (§6.2, below): its circle over 75 m, or
  5 km since its start, a placing or a trusted fix, offers the chip.
- `useKeepAwake()` while the map screen is focused.

### 6.2 Camera modes

`follow` → `follow-heading` → `free`. User pan/zoom gesture switches to `free`. `RecenterButton` cycles modes and shows the current one.

When the navigator started from where the car was parked and a Wi-Fi fix puts it elsewhere (NAVIGATOR-SPEC §6.1), a card under the status pill asks "Is the car where the dot is?", with how far Wi-Fi puts it: "Yes, it's here" keeps the dot, "No" moves it to the Wi-Fi position. It stays until answered or settled by the fixes; it never blocks the map.

Putting the car on the map (NAVIGATOR-SPEC §6.2): while standing, without GPS, and with nothing vouching for the dot — rough, no direction, map matching `offroad`, or over 5 km driven since the last trusted fix — a chip "Set your position on the map"; "No" to the parked-pose question opens it too. The map zooms in with a centre pin and a card ("Where is the car?" · Cancel / Here), then "Which way does it face?": a tap draws an arrow from the pin that way, another tap turns it (Cancel / Skip, then Cancel / Confirm). Moving off cancels. The confirmed spot and arrow stay on the map, fainter, until the dot is 50 m away or the car is placed again.

The vehicle button in the footer carries the connection dot: green when the car answers and is known (VIN read or remembered); yellow while connecting, searching the protocol, with the car off or not answering, or the VIN still asked; red with no adapter, an error, a car whose VIN never came after every retry, or yellow (pulsing: scaled 1 → 1.35 → 1 each second) for 25 s in a row (the VIN retries go on, and the dot turns green when they succeed). The 25 s count from the link's `tryingSinceMs`: kept across auto-connect's turns between adapters, restarted by each step forward (the adapter answers, the car answers) and by a new attempt (Connect, auto-connect starting over), so red turns yellow again when something moves. While a trip records, the button's label reads "Driving" ("У дорозі") in the accent colour: the car is on its way (the trip recorder itself is under More, where its row says "Recording"). On the vehicle screen the adapter's button reads "Stop searching" while waiting for the adapter (`connecting`, `reconnecting`), "Disconnect" once it answers.

While the OBD adapter searches all protocols (`protocolSearch`, another car on it: up to ~20 s), a chip under the status pill says "Finding the car's protocol…", and the vehicle screen's adapter tile says the same.

Heading-up bearing: the walking compass beam when shown; else the navigator heading (`dr`/`fused` source, valid while stopped); else GNSS course when speed > ~2 m/s; else the last of these held, so the map does not snap north at a stop. No direction known while standing (none yet: parked on phone GPS before a trip, the app just opened): heading-up keeps its camera (zoom 17, tilted) and the map keeps the bearing it has, so the view doesn't drop flat and north while the button says heading-up. Moving without one (the navigator anchored under GNSS jamming): the `follow` camera (zoom 16, flat, north up) until there is one, so it never looks like a heading-up view pointing the wrong way. The bearing goes to the map in [0°, 360°): iOS MapLibre ignores a negative one, and the dead-reckoning heading is signed.

Auto heading-up: once per trip, when a trip is recording and speed stays > ~2 m/s for 2 s, `follow` switches to `follow-heading` (any other mode is left alone). When the trip ends (recorder leaves `recording`/`lingering`) it goes back to `follow`, unless the driver changed the mode by button or gesture in between.

Tilt: the camera tilts to 50° (navigator view) while a trip is recording or when zoomed in to ≥ 16.5 (back to top-down below 16). It applies in every mode and returns to top-down while the ghost view is open. Pitch is set only when this rule flips, so a manual two-finger tilt stays until then.

Following the dot: each position eases over 450 ms, but a step over 80 m is a snap, not driving (GNSS back after an outage, a navigator reset, a placing) and the camera jumps to it. Easing a snap pans the whole way at follow zoom, and the next position (2 Hz) restarts the ease from wherever the pan reached, so the camera crawls in asymptotically — on 2026-10-06 a 10 km snap took a visible age to arrive. Leaving follow clears the last centre, so coming back to it eases in from wherever the map was left. At 140 km/h a car covers 19 m between two published positions (2 Hz), so 80 m only ever catches a real discontinuity: over every log kept (`replay:doubt`, 35 833 published positions) 133 steps cross it, and on the 53 km drive back exactly one does — the 10 km snap when GPS came back. 92 of the 133 are on the jammed 58 km drive, where the matcher switched between hypotheses up to 296 m apart at 110–130 km/h (MAPMATCH-SPEC §15, item 14); the dot really did move that far, so a jump is the honest way to draw it.

### 6.3 Overlays — `src/components/map/`

One small component each. Touch targets ≥ 56 pt; high contrast; minimal text.

| Position | Component           | Content                                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Top      | Status pill         | Trust state in words, coloured by it (`GPS OK`, "GPS looks spoofed", "GPS is back — verifying", no fix) |
| Top      | `SinceTrustedStrip` | While GNSS isn't trusted: "Trusted GPS 4 min ago, 2.3 km back"                             |
| Top      | `RouteBanner`       | Only with a route: next maneuver, distance, what is left (below, and §7.1)                 |
| Top      | Chips and cards     | Protocol search, parked-pose question, set your position, outside the region (§6.2, below) |
| Bottom   | Speed               | Speed in km/h                                                                              |
| Bottom   | Camera button       | Camera mode cycle (§6.2)                                                                   |
| Bottom   | Bar                 | Route, Vehicle (with the connection dot; "Driving" while a trip records), More              |
| Center   | `PermissionCard`    | Location denied → explanation + "Open Settings" (`Linking.openURL('app-settings:')`)       |
| Center   | `NoFixCard`         | "Waiting for GPS…" when no fix yet                                                         |

- **Outside the region** (`src/components/map/region-prompt.tsx`): when the position (any fix to
  5 km, Wi-Fi and cell ones too, but not one suspected of spoofing) is more than max(1 km, its accuracy) outside
  the active region's outline (`region-check.ts`; bounds for releases without
  outlines), a card "Outside <region>" offers **Switch map** to a downloaded region that has the car, else
  **Download** the smallest catalog region that has it (an oblast before Ukraine; the catalog is fetched once,
  then; the downloaded region becomes the map when installed), else Offline data. "Not now" hides it for that
  pair of regions until the app restarts. Hidden while that region downloads. Wi-Fi fixes count: built for trusted
  GNSS only, it never prompted indoors.
- Long-press on map → drops a pin; a card above the toolbar shows its distance and direction, a ✕ to cancel, and
  **Route here** (ROUTING-SPEC §8). While the car stands (or there is no position yet) it also offers **I'm here**:
  putting the car on the map (NAVIGATOR-SPEC §6.2), starting at the pin instead of the dot.
- With a route (`src/components/route/route-banner.tsx`): the banner shows the next maneuver's icon, the distance
  to it (10 m steps under 300 m, 50 m under 1 km), its instruction, "then …" when the next follows within 120 m,
  and the distance, time and arrival clock left; or "Planning route…", "Off route, planning again…", "Position
  uncertain: keeping the route", "No route" with the reason, "You've arrived". While the planner works a thin bar
  sweeps under the text (accent; amber for a re-plan), and for a first plan a ring pulses out of the icon; both hold
  still with the system's Reduce Motion. Its × ends the route; its speaker
  button mutes the spoken maneuvers (ROUTING-SPEC §8.5) and is hidden while the voice volume in Settings is 0; holding it opens the system's audio output picker
  (iOS: Apple's, iPhone / Bluetooth / AirPlay; Android: the media output panel), and while the voice goes off the phone (a car's Bluetooth) it shows the AirPlay
  audio glyph instead of the speaker. The two buttons are 38 pt, the × at the top and the voice at the bottom, at
  least 20 pt apart, their touch areas not overlapping (a mis-tap on × ended the route). The map draws the route ahead of the car (from its
  progress point, ROUTING-SPEC §8.1: what is driven disappears; faded while planning again; the stretch from the
  progress point to the next route vertex is dashed in the accent blue), its next maneuver and the destination.
  **Alternatives** (ROUTING-SPEC §8.7) are quieter solid blue lines under it (`routeAlt`: light #93A6DE, dark
  #7489C2; a translucent route colour turned muddy on the dark map), each labelled on its own stretch
  with its time against the route ("+4 min", "−2 min", "Same time"); a tap on a line or label follows it. When they
  come while the car stands, the map frames all routes once (free camera).
- **A route without an adapter** (phone-only mode on and no adapter connected, NAVIGATOR-SPEC §9.6): **Route here**
  and **Start guidance** don't plan at once. The destination is held (`route-without-adapter.ts`) and a card on the
  map says, first, where the position comes from: GPS has it (trusted), it was set on the map {age} ago, or "set
  your position on the map while the car stands" with **Set position** (the placing, §6.3 above; "stop the car" while
  it moves); second, "follow the route exactly: the app keeps track of the car by its turns, and a turn off the
  route loses it; then stop and set your position again". The route is planned only on **I'll follow the route**
  (noted `route without an adapter: the driver will follow it`); its ✕ drops it.

## 7. Pages

### 7.1 `route`

- Field empty, only what a route can reach (inside the active region's bounds):
  - **Saved**: Home, Work, then favourites (`src/services/navigation/places-store.ts`, kv-store `places.saved`).
  - **Recent**: the last 10 destinations guided to from this screen, newest first, one per place (within 30 m);
    "Clear recent" (kv-store `places.recent`).
  - **Cities · <region>**: the region's 8 largest cities and towns from its search index
    (`SearchIndex.majorSettlements`); without an index, the built-in city list inside the region's bounds.
- Typing: with the region's search index (SEARCH-SPEC §6), places, streets, house numbers and POIs from it, each
  with what it is, its settlement, distance and direction; without one, the cities above filtered by name, and a
  note to download the region again.
- Selected result or city → summary card: straight-line distance, bearing and time at 60 km/h; once its route is planned, the
  road distance and the planned time. Under it: **Home**, **Work**, **Save** (a place is saved under one kind;
  setting Home or Work replaces the old one), or "Saved as Home · Remove" once saved. Saving or removing shows a
  confirmation strip that springs in ("Added to quick picks as Home", "Replaces <old Home>", "Removed from quick
  picks") with **Undo**; back in the list, the saved row glows once. Saved places show their kind's icon in search
  results and recents.
- "Start guidance" plans a road route from the position (ROUTING-SPEC, `runtime.routes`, `useRoute()` in
  `src/providers/route-provider.tsx`) and returns to the map; "Stop guidance" ends it. A failed plan says why.
- **I'm here** on the summary card, while the car stands: back to the map, putting the car on the map
  (NAVIGATOR-SPEC §6.2) starting at the place (`src/services/navigation/place-request.ts` hands it over).
- Footnote: long-press the map to route anywhere, or to say the car is there; routes stay inside the downloaded region.

### 7.2 `vehicle`

The car only: the adapter list and connection, the connected adapter's details, live OBD signals, VIN, engine state
and odometry stage; specified in [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) §9.1 and
[VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md) §7. The learned calibration shows in its developer section (SPEC §3.6).

### 7.3 `more`

The list: How to use? (the Guide, §7.7), Offline maps (`more/downloads`, §7.4), Settings (§7.6), then the diagnostic
pages `position` (integrity, live GNSS, EKF and map matching state, routing timings), `recorder` (Trip recorder:
everything about trip logs, TRIP-LOGGER-SPEC §9.2) and `developer` (test switches and knobs, the ELM terminal).

### 7.4 `downloads`

- Regions of the newest map release (README of `tools/tiles`): download, pause, resume, delete, switch the active
  one, update; the catalog source (GitHub or a PC's `tiles serve`).
- **No online map:** the map draws only the active offline region. Until one is usable, the `map-setup` screen
  (full-screen, no close or swipe; after onboarding) shows the same region list with "Download a map" above it, and
  closes itself once the region is installed. Deleting the last region brings it back.

### 7.5 (removed)

The `debug` and `calibration` screens of the first milestone are gone: diagnostics live under More (§7.3), and
calibration is learned while driving (SPEC §3.6).

### 7.6 `settings`

- Language: System / English / Українська (persisted).
- Appearance: System / Light / Dark (persisted).
- Voice volume for the spoken maneuvers (ROUTING-SPEC §8.5).
- Privacy statement (position data on device; maps downloaded once, then offline; crash reports carry no location or
  personal data; the opt-in trip log upload, in the `recorder` page).
- About: app version, support code (the install id testers send), map data credit.

### 7.7 Guide (`guide`, `lesson`)

How to use the app, for drivers. Design: [design/guide/](design/guide/) (Claude Design canvas "wtf.ai Guide &
Onboarding"). Strings in `src/i18n/guide-en.ts` / `guide-uk.ts`; driver advice is an action ("Keep driving
normally"), never "Nothing".

- **Onboarding** ends with a phone holder step (the gyro is the only yaw source without GPS, SPEC §2): a firm
  holder, any angle, a phone picked up catches up; the Guide is in More.
- **Map tour** (`src/components/guide/map-tour.tsx`): offered once on the map after onboarding and the first map
  (a card above the camera button, hidden while a pin, a placing or the parked-pose question is up; kv-store
  `guide.tour-offered`), and from the Guide at any time (the pages close first). The screen dims except one control
  at a time, with a card (step, title, text, Back / Next, Skip): the status pill, the dot (the screen centre: the
  tour starts the follow camera), press and hold (a pulsing ring), the camera button, Vehicle and More (thirds of
  the bottom bar). Done leaves a note for 6 s with a link to the Guide.
- **Guide** page: the first row of More, "How to use? · {done} of {total} done". The tour card, the lessons
  in groups (Getting started, When GPS fails, Routes, Maps) with a tick once done (kv-store `guide.done`), "Show the
  first-run screens again".
- **Lessons** (`guide/lesson?id=`), full pages pushed from the Guide, each interactive, on drawn maps (`react-native-svg`, `src/components/guide/mini-map.tsx`)
  in the map's colours: never the live map, so practising never moves the car. The button at the bottom marks the
  lesson done and opens the next. The Guide lists only lessons that exist (`lesson-bodies.tsx`).
  1. Before you drive: the map and the adapter read from the app, the holder, opening the app first and charging
     ticked by the driver.
  2. What the dot is telling you: the five trust states on one map.
  3. The car button: its four states, a checklist when red.
  4. Driving through jamming: a drive played in five stages (GPS ok, jammed, 4 min, a turn, GPS back; 4 s each, the
     stage's button filling as its time runs, the car moving between them), with or without the adapter (without,
     the dot holds the last fix and the circle grows).
  5. Put the car on the map: as on the map, the map dragged under the centre pin, Here, a tap for the heading,
     Confirm. It leads to the right answer: a target circle around the car (the area that counts), Here only with the
     pin's point in it (it snaps onto the car), a circle ahead of the car, Confirm only with the arrow along the road
     the way the car faces. The lesson's pin is drawn so its point is exactly the placed spot; the cards sit at the
     bottom of the lesson's small map, leaving the road ahead free to tap (`placing-map.tsx`, shared with lesson 6).
     While placing, the page's back swipe is off (a drag from the map's edge moves the map) and Android's back cancels
     the placing instead of leaving the lesson.
  6. "Is the car where the dot is?": both answers. No moves the dot to Wi-Fi's guess and starts placing there, as on
     the map; the car is up the street.
  7. Plan a route: a long press anywhere drops the pin (I'm here moves the dot there; Route here plans), or search a
     saved place. The drawn map is a real road network (`route-map.ts`, `MemoryRoadGraph`): the app's router plans
     on it, the real route banner shows the maneuvers and the voice says the first one (unless muted).
  8. Spoken directions: the real banner on a planned route (a tap mutes, a long press opens the phone's audio
     output list) and the Settings volume slider, for the lesson only (0 hides the button; let go, it says the
     route's instruction at that volume).
  9. Offline maps: the Offline maps screen as drawn there, with the phone's own regions when it has them (only the map
     in use starts downloaded, so there is one to try); downloads, switching and deleting are pretend.

  The lessons draw the map's own pieces: its status pill, puck (blue when trusted, else yellow with a dashed circle;
  the cone always along the road, where the car stands nudged by turning the phone: half the turn, at most ±20°),
  cards, chips and bottom bar.

## 8. Verification

1. `npx expo lint`, `npx tsc --noEmit`, `npx jest` pass.
2. On device:
   - Permission prompt appears, localized per device language.
   - Puck tracks while walking/driving; accuracy circle scales with reported accuracy.
   - Driving off on a trip turns follow into heading-up; it holds its heading at a stop; pan → free; recenter
     restores follow.
   - Airplane mode / indoors → no fix within ~8 s.
   - Deny permission → `PermissionCard`.
   - Dark mode switches the map style.
   - Every page opens and goes back by the system's gesture; Ukrainian strings fit without overflow.
   - Route: select a destination → distance plausible; Start → line, alternatives and banner on the map.
