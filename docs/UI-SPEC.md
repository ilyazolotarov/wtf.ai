# wtf.ai — UI-First Milestone Specification

Status: draft v1 (2026-09-29). Companion to [SPEC.md](SPEC.md) §3.9. Source of truth for coding agents implementing the UI milestone.

> Builds (2026-10-03): EAS is no longer used. Read the EAS steps in §3 as history; builds come from GitHub Actions as unsigned IPAs sideloaded with AltStore (SPEC §2, AGENTS.md).
>
> Redesign (2026-10-03): the UI follows the **Calm** design (claude.ai/design project "wtf.ai Redesign", option 1b): Onest type, frosted-glass map panels (`expo-blur` + translucent tint, `src/components/ui/glass-fill.tsx`), sentence-case trust status, big light speed numeral, OpenFreeMap **Liberty** style in both color schemes. Theme tokens live in `src/constants/theme.ts` (`usePalette()`), icons in `src/components/ui/icon.tsx` (Material names → SF Symbols). Changes to the sections below: the menu is a `more` sheet (Offline data, Calibration, Diagnostics, Settings; nested sheets get `?from=more` for a back button); sheets draw their own header (`headerShown: false`); Settings adds an Appearance override (System / Light / Dark via `Appearance.setColorScheme`, persisted); a first-run `onboarding` route (welcome → location → adapter → calibration) shows until `onboarding-done` is set in kv-store; on `UNTRUSTED` the map shows the raw GNSS ghost and can frame it ("Show where GPS thinks you are").
>
> Position source (2026-10-03): §4.3 is updated. The map's GNSS now comes from `modules/sensor-capture` (shared with the trip log), not `expo-location`'s watcher, which stopped for good after jamming. Only satellite fixes count for trust. Since then `NavigatorService` ([NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) §9) is the map's source; it shows phone GNSS as below when there is no OBD speed.
>
> Follow-up (2026-10-06): the `calibration` screen, the onboarding calibration step and the low-accuracy / "Not calibrated" chip are removed: the app calibrates itself while driving (SPEC §3.6). `SinceTrustedStrip` (§6.3) is a chip under the status pill while GNSS isn't trusted: "Trusted GPS 4 min ago, 2.3 km back". The `more` sheet lists Offline maps and Settings; `src/mocks` is gone.

> Follow-up (2026-10-03): the mock `vehicle` (§7.2) and `debug` (§7.5) screens become real in the trip logger milestone — see [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) §9 and [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). The `AdapterChip` (§6.3) then shows the real link state.

## 1. Goal

Get a visible, working app on the iPhone fast:

- **Map screen with real data**: live GNSS position via a `PositionSource` abstraction, so the EKF can replace it later without UI changes.
- **All other screens** from SPEC §3.9 built with **static placeholder data** (mocks).

## 2. Decisions

| Topic      | Decision                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Build      | No dev build yet → first step is an EAS dev build. MapLibre does not run in Expo Go.                                                            |
| Map tiles  | OpenFreeMap **Liberty** style on offline PMTiles of the downloaded region (SPEC §3.8); no online map since 2026-10-06.                      |
| Navigation | **Map-first**: full-screen map with floating controls; other screens are stack routes presented as sheets/modals. Remove template `NativeTabs`. |
| Mocks      | Static placeholder data only (no simulated scenarios).                                                                                          |
| Language   | English + Ukrainian, i18n-ready. Default: the first device language the app speaks, Russian as Ukrainian (iOS and Android); user override in Settings.                                                         |
| Theme      | Follow system light/dark; map style switches too.                                                                                               |
| Units      | SI internally (m, s, rad, m/s). Convert to km/h, km/m, degrees only in UI.                                                                      |
| Privacy    | Offline map only: no map requests while driving or browsing. GitHub is contacted for the catalog and downloads only.                       |

## 3. Phase 0 — Dev build foundation

Blocks seeing the map on a device.

1. Install all native deps in **one** batch (each native change costs an EAS build) via `npx expo install`:
   - `expo-dev-client`, `expo-location`, `@maplibre/maplibre-react-native`, `expo-localization`, `expo-keep-awake`, `expo-sqlite` (kv-store for settings now, per-VIN calibration later).
   - Recommended (saves a rebuild before the SPEC Phase 1 logger): `expo-sensors`, `expo-file-system`, `expo-sharing`.
2. `app.json`:
   - `expo-location` plugin with **when-in-use** permission text only (background location comes in SPEC Phase 6).
   - `@maplibre/maplibre-react-native` plugin.
   - `ios.bundleIdentifier`.
   - `locales` for `en` and `uk`, and `ru` with the Ukrainian strings (localized iOS permission strings).
3. `eas.json` with a `development` profile (`developmentClient: true`, `distribution: internal`).
4. `npx eas-cli@latest device:create` → register iPhone. `npx eas-cli@latest build -p ios --profile development`. See the `expo-dev-client` and `eas-app-stores` skills.
5. From here on, Expo Go no longer works; use the dev client with `npx expo start`.

## 4. Phase 1 — Foundations

Can run in parallel with Phase 0 once deps are installed.

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

- `haversineM(a, b)`, `bearingRad(a, b)`, `circlePolygon(center, radiusM, steps)` → GeoJSON Polygon.
- Unit tests with `jest-expo` (first test setup in the repo; follow Expo unit-testing docs).

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

### 4.6 Mocks — `src/mocks/`

Typed static data; real services will later return the same types.

- Adapter state (OBDLink MX+ over ExternalAccessory, `disconnected`; ELM327 version, OBD protocol, poll rate all `null`).
- Vehicle: VIN `null`, odometry Stage 1 (SPEC §2.1), OBD speed and yaw rate `null`, yaw source phone gyro.
- Calibration status (`not-calibrated`, 3 steps).
- Download packs (map tiles, routing data — size, version, status).
- EKF state (all `null`).
- Destinations: Kyiv, Lviv, Odesa, Dnipro, Kharkiv, Zaporizhzhia, Vinnytsia (name EN/UK + coordinates).

### 4.7 Theme & map config

- Extend `src/constants/theme.ts` with status colors (light + dark): `trustOk`, `untrusted`, `reacquiring`, `noFix`, `puck`, `ghost`, `accuracyFill`.
- `src/config/map.ts`: OpenFreeMap light and dark style URLs (verify current URLs at openfreemap.org) + `getMapStyle(scheme)`.

## 5. Phase 2 — Navigation shell

Depends on 4.4 and 4.5.

1. `src/app/_layout.tsx`: `Stack` wrapped in `ThemeProvider` → `I18nProvider` → `PositionProvider`.
   - `index`: `headerShown: false`.
   - `route`, `vehicle`, `calibration`, `downloads`, `debug`, `settings`: `formSheet` or `modal` presentation. Check the `expo-router` skill for SDK 57 options.
2. Remove template leftovers: `src/app/explore.tsx`, `src/components/app-tabs.tsx`, `app-tabs.web.tsx`, `hint-row.tsx`, `web-badge.tsx`, `animated-icon*`, and `ui/collapsible.tsx` / `external-link.tsx` if unused.

## 6. Phase 3 — Map screen (`src/app/index.tsx`, real data)

Depends on Phase 2.

### 6.1 Map

- Full-screen MapLibre `MapView`, style from `getMapStyle(colorScheme)`. Read the MapLibre RN docs for the installed version before coding (API changed between majors).
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

Heading-up bearing: the walking compass beam when shown; else the navigator heading (`dr`/`fused` source, valid while stopped); else GNSS course when speed > ~2 m/s; else the last of these held, so the map does not snap north at a stop. No direction known while standing (none yet: parked on phone GPS before a trip, the app just opened): heading-up keeps its camera (zoom 17, tilted) and the map keeps the bearing it has, so the view doesn't drop flat and north while the button says heading-up. Moving without one (the navigator anchored under GNSS jamming): the `follow` camera (zoom 16, flat, north up) until there is one, so it never looks like a heading-up view pointing the wrong way. The bearing goes to the map in [0°, 360°): iOS MapLibre ignores a negative one, and the dead-reckoning heading is signed, so until 2026-10-06 the map stopped turning whenever the car drove west under jamming.

Auto heading-up: once per trip, when a trip is recording and speed stays > ~2 m/s for 2 s, `follow` switches to `follow-heading` (any other mode is left alone). When the trip ends (recorder leaves `recording`/`lingering`) it goes back to `follow`, unless the driver changed the mode by button or gesture in between.

Tilt: the camera tilts to 50° (navigator view) while a trip is recording or when zoomed in to ≥ 16.5 (back to top-down below 16). It applies in every mode and returns to top-down while the ghost view is open. Pitch is set only when this rule flips, so a manual two-finger tilt stays until then.

Following the dot: each position eases over 450 ms, but a step over 80 m is a snap, not driving (GNSS back after an outage, a navigator reset, a placing) and the camera jumps to it. Easing a snap pans the whole way at follow zoom, and the next position (2 Hz) restarts the ease from wherever the pan reached, so the camera crawls in asymptotically — on 2026-10-06 a 10 km snap took a visible age to arrive. Leaving follow clears the last centre, so coming back to it eases in from wherever the map was left. At 140 km/h a car covers 19 m between two published positions (2 Hz), so 80 m only ever catches a real discontinuity: over every log kept (`replay:doubt`, 35 833 published positions) 133 steps cross it, and on the 53 km drive back exactly one does — the 10 km snap when GPS came back. 92 of the 133 are on the jammed 58 km drive, where the matcher switched between hypotheses up to 296 m apart at 110–130 km/h (MAPMATCH-SPEC §15, item 14); the dot really did move that far, so a jump is the honest way to draw it.

### 6.3 Overlays — `src/components/map/`

One small component each. Touch targets ≥ 56 pt; high contrast; minimal text.

| Position | Component           | Content                                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Top      | `TrustBadge`        | `GPS OK` / `UNTRUSTED` / `REACQUIRING` / `NO FIX`, colored by trust state                  |
| Top      | `SinceTrustedStrip` | Time and distance since last trusted fix, while not trusted                                |
| Top      | `AdapterChip`       | Adapter status (mock: Disconnected); tap → `vehicle`                                       |
| Top      | `RouteBanner`       | Only with a route: next maneuver, distance, what is left (below, and 7.1)                  |
| Bottom   | `SpeedReadout`      | Speed in km/h (GNSS speed)                                                                 |
| Bottom   | `RecenterButton`    | Camera mode cycle                                                                          |
| Bottom   | `MapToolbar`        | Route, Vehicle, menu → Downloads, Calibration, Debug, Settings (`Link` from `expo-router`) |
| Center   | `PermissionCard`    | Location denied → explanation + "Open Settings" (`Linking.openURL('app-settings:')`)       |
| Center   | `NoFixCard`         | "Waiting for GPS…" when no fix yet                                                         |

- **Outside the region** (`src/components/map/region-prompt.tsx`, 2026-10-06): when the position (any fix to
  5 km, Wi-Fi and cell ones too, but not one suspected of spoofing) is more than max(1 km, its accuracy) outside
  the active region's outline (`region-check.ts`; bounds for releases without
  outlines), a card "Outside <region>" offers **Switch map** to a downloaded region that has the car, else
  **Download** the smallest catalog region that has it (an oblast before Ukraine; the catalog is fetched once,
  then; the downloaded region becomes the map when installed), else Offline data. "Not now" hides it for that
  pair of regions until the app restarts. Hidden while that region downloads. (First built for trusted GNSS
  only, which never prompted indoors: a Wi-Fi fix is "APPROXIMATE", never trusted.)
- Long-press on map → drops a pin; a card above the toolbar shows its distance and direction, a ✕ to cancel, and
  **Route here** (ROUTING-SPEC §8). While the car stands (or there is no position yet) it also offers **I'm here**:
  putting the car on the map (NAVIGATOR-SPEC §6.2), starting at the pin instead of the dot.
- With a route (`src/components/route/route-banner.tsx`): the banner shows the next maneuver's icon, the distance
  to it (10 m steps under 300 m, 50 m under 1 km), its instruction, "then …" when the next follows within 120 m,
  and the distance, time and arrival clock left; or "Planning route…", "Off route, planning again…", "Position
  uncertain: keeping the route", "No route" with the reason, "You've arrived". Its × ends the route; its speaker
  button mutes the spoken maneuvers (ROUTING-SPEC §8.5) and is hidden while the voice volume in Settings is 0; holding it opens the system's audio output picker
  (iOS: Apple's, iPhone / Bluetooth / AirPlay; Android: the media output panel), and while the voice goes off the phone (a car's Bluetooth) it shows the AirPlay
  audio glyph instead of the speaker. The two buttons are 38 pt, the × at the top and the voice at the bottom, at
  least 20 pt apart, their touch areas not overlapping (a mis-tap on × ended the route). The map draws the route ahead of the car (from its
  progress point, ROUTING-SPEC §8.1: what is driven disappears; faded while planning again; the stretch from the
  progress point to the next route vertex is dashed in the accent blue), its next maneuver and the destination.
- **A route without an adapter** (phone-only mode on and no adapter connected, NAVIGATOR-SPEC §9.6): **Route here**
  and **Start guidance** don't plan at once. The destination is held (`route-without-adapter.ts`) and a card on the
  map says, first, where the position comes from: GPS has it (trusted), it was set on the map {age} ago, or "set
  your position on the map while the car stands" with **Set position** (the placing, §6.3 above; "stop the car" while
  it moves); second, "follow the route exactly: the app keeps track of the car by its turns, and a turn off the
  route loses it; then stop and set your position again". The route is planned only on **I'll follow the route**
  (noted `route without an adapter: the driver will follow it`); its ✕ drops it.

## 7. Phase 4 — Mock screens

Parallel with Phase 3; each screen is independent. Use `@expo/ui` for settings-like lists (see `expo-ui` skill).

Pages, not sheets (2026-10-10): everything opened from the map (Route, Vehicle, Offline maps, More and what it opens,
the Guide and its lessons, the developer pages) is a page pushed on the one root stack, sliding in from the right, so
going back is the system's: the swipe from the left edge on iOS, the back gesture or button on Android. The page
header (`ScreenContent`) has a back button, and from the second level down a ✕ straight back to the map. (A form
sheet can't hold a stack, and iOS has no back swipe for a sheet.) Onboarding and the first map download stay
full-screen modals: there is nothing to go back to.

### 7.1 `route`

- Field empty (2026-10-06), only what a route can reach (inside the active region's bounds):
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

- Adapter card: model OBDLink MX+, connection ExternalAccessory, status Disconnected, ELM327 version / OBD protocol / speed poll rate `—`, Connect button disabled.
- Odometry: VIN `—`; stage "1 · OBD speed + phone gyro".
- Live signals placeholders (`—`): speed (OBD), yaw rate.
- Yaw source: "Phone gyro". (Stage 2+ rows — wheel speeds, gear, profile — come with SPEC Phase 8.)

### 7.3 `calibration` (removed 2026-10-06)

No screen: calibration is learned while driving (SPEC §3.6).

### 7.4 `downloads`

- Regions of the newest map release (README of `tools/tiles`): download, pause, resume, delete, switch the active
  one, update; the catalog source (GitHub or a PC's `tiles serve`).
- **No online map** (2026-10-06): the map draws only the active offline region. Until one is usable, the
  `map-setup` screen (full-screen, no close or swipe; after onboarding) shows the same region list with "Download a
  map" above it, and closes itself once the region is installed. Deleting the last region brings it back.

### 7.5 `debug`

- **Live** GNSS section: lat, lon, accuracy, speed, heading, fix age, update rate (Hz).
- Mock: integrity state, EKF state table (E, N, ψ, v, k_s, b_ω, k_ω), OBD polls/s.
- Logging toggle + Export button, disabled.

### 7.6 `settings`

- Language: System / English / Українська (persisted).
- Appearance: follows system (info only).
- Privacy statement (position data on device; maps downloaded once, then offline; crash reports carry no location or personal data; the opt-in trip log upload, in the `recorder` sheet).
- About: app version (`expo-constants`).

Trip log upload and the storage limit are not here: they live with the rest of trip logging in the `recorder`
sheet (TRIP-LOGGER-SPEC §9.2).

### 7.7 Guide (`guide`, `lesson`)

How to use the app, for drivers. Design: [design/guide/](design/guide/) (Claude Design canvas "wtf.ai Guide &
Onboarding"). Strings in `src/i18n/guide-en.ts` / `guide-uk.ts`; driver advice is an action ("Keep driving
normally"), never "Nothing".

- **Onboarding** ends with a phone holder step (the gyro is the only yaw source without GPS, SPEC §2): a firm
  holder, any angle, a phone picked up catches up; the Guide is in More.
- **Map tour** (`src/components/guide/map-tour.tsx`): offered once on the map after onboarding and the first map
  (a card above the camera button, hidden while a pin, a placing or the parked-pose question is up; kv-store
  `guide.tour-offered`), and from the Guide at any time (the sheets close first). The screen dims except one control
  at a time, with a card (step, title, text, Back / Next, Skip): the status pill, the dot (the screen centre: the
  tour starts the follow camera), press and hold (a pulsing ring), the camera button, Vehicle and More (thirds of
  the bottom bar). Done leaves a note for 6 s with a link to the Guide.
- **Guide** sheet: the first row of More, "How to use? · {done} of {total} done". The tour card, the lessons
  in groups (Getting started, When GPS fails, Routes, Maps) with a tick once done (kv-store `guide.done`), "Show the
  first-run screens again".
- **Lessons** (`guide/lesson?id=`), full pages pushed from the Guide (a sheet left too little room), each interactive, on drawn maps (`react-native-svg`, `src/components/guide/mini-map.tsx`)
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
     output list) and the Settings volume slider, for the lesson only (0 hides the button; at rest it says the
     route's instruction at that volume).
  9. Offline maps: the Offline maps screen as drawn there, with the phone's own regions when it has them (only the map
     in use starts downloaded, so there is one to try); downloads, switching and deleting are pretend.

  The lessons draw the map's own pieces: its status pill, puck (blue when trusted, else yellow with a dashed circle;
  the cone always along the road, where the car stands nudged by turning the phone: half the turn, at most ±20°),
  cards, chips and bottom bar.

## 8. Verification

1. `npx expo lint`, `npx tsc --noEmit`, `npx jest` pass.
2. `npx expo-doctor` clean; EAS dev build installs on iPhone and connects to `npx expo start`.
3. On device:
   - Permission prompt appears, localized per device language.
   - Puck tracks while walking/driving; accuracy circle scales with reported accuracy.
   - Driving off on a trip turns follow into heading-up; it holds its heading at a stop; pan → free; recenter restores follow.
   - Airplane mode / indoors → `NO FIX` within ~5 s.
   - Deny permission → `PermissionCard`.
   - Dark mode switches map style.
   - All sheets open/close; Ukrainian strings fit without overflow.
   - Route: select destination → distance plausible; Start → line + banner on map.
4. Debug GNSS values match the puck; update rate ≈ 1 Hz.

## 9. Out of scope (this milestone)

Background location; EKF, integrity, calibration logic; vehicle-link module (ELM327 / CAN); real routing and downloads; persistence beyond language setting; web and Android polish.
