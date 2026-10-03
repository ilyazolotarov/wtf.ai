# wtf.ai — UI-First Milestone Specification

Status: draft v1 (2026-09-29). Companion to [SPEC.md](SPEC.md) §3.9. Source of truth for coding agents implementing the UI milestone.

> Builds (2026-10-03): EAS is no longer used. Read the EAS steps in §3 as history; builds come from GitHub Actions as unsigned IPAs sideloaded with AltStore (SPEC §2, AGENTS.md).
>
> Redesign (2026-10-03): the UI follows the **Calm** design (claude.ai/design project "wtf.ai Redesign", option 1b): Onest type, frosted-glass map panels (`expo-blur` + translucent tint, `src/components/ui/glass-fill.tsx`), sentence-case trust status, big light speed numeral, OpenFreeMap **Liberty** style in both color schemes. Theme tokens live in `src/constants/theme.ts` (`usePalette()`), icons in `src/components/ui/icon.tsx` (Material names → SF Symbols). Changes to the sections below: the menu is a `more` sheet (Offline data, Calibration, Diagnostics, Settings; nested sheets get `?from=more` for a back button); sheets draw their own header (`headerShown: false`); Settings adds an Appearance override (System / Light / Dark via `Appearance.setColorScheme`, persisted); a first-run `onboarding` route (welcome → location → adapter → calibration) shows until `onboarding-done` is set in kv-store; on `UNTRUSTED` the map shows the raw GNSS ghost and can frame it ("Show where GPS thinks you are").
>
> Position source (2026-10-03): §4.3 is updated. The map's GNSS now comes from `modules/sensor-capture` (shared with the trip log), not `expo-location`'s watcher, which stopped for good after jamming. Only satellite fixes count for trust. The navigator replaces this source next ([NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) §9).
>
> Follow-up (2026-10-03): the mock `vehicle` (§7.2) and `debug` (§7.5) screens become real in the trip logger milestone — see [TRIP-LOGGER-SPEC.md](TRIP-LOGGER-SPEC.md) §9 and [VEHICLE-LINK-SPEC.md](VEHICLE-LINK-SPEC.md). The `AdapterChip` (§6.3) then shows the real link state.

## 1. Goal

Get a visible, working app on the iPhone fast:

- **Map screen with real data**: live GNSS position via a `PositionSource` abstraction, so the EKF can replace it later without UI changes.
- **All other screens** from SPEC §3.9 built with **static placeholder data** (mocks).

## 2. Decisions

| Topic      | Decision                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Build      | No dev build yet → first step is an EAS dev build. MapLibre does not run in Expo Go.                                                            |
| Map tiles  | **OpenFreeMap** online vector styles (no API key) for now. Style URLs live in one config file so offline PMTiles can replace them later.        |
| Navigation | **Map-first**: full-screen map with floating controls; other screens are stack routes presented as sheets/modals. Remove template `NativeTabs`. |
| Mocks      | Static placeholder data only (no simulated scenarios).                                                                                          |
| Language   | English + Ukrainian, i18n-ready. Default from device locale, user override in Settings.                                                         |
| Theme      | Follow system light/dark; map style switches too.                                                                                               |
| Units      | SI internally (m, s, rad, m/s). Convert to km/h, km/m, degrees only in UI.                                                                      |
| Privacy    | OpenFreeMap leaks map viewport to a third party → **dev-only exception** to SPEC §2 privacy rule. Record in SPEC §9; remove with offline tiles. |

## 3. Phase 0 — Dev build foundation

Blocks seeing the map on a device.

1. Install all native deps in **one** batch (each native change costs an EAS build) via `npx expo install`:
   - `expo-dev-client`, `expo-location`, `@maplibre/maplibre-react-native`, `expo-localization`, `expo-keep-awake`, `expo-sqlite` (kv-store for settings now, per-VIN calibration later).
   - Recommended (saves a rebuild before the SPEC Phase 1 logger): `expo-sensors`, `expo-file-system`, `expo-sharing`.
2. `app.json`:
   - `expo-location` plugin with **when-in-use** permission text only (background location comes in SPEC Phase 6).
   - `@maplibre/maplibre-react-native` plugin.
   - `ios.bundleIdentifier`.
   - `locales` for `en` and `uk` (localized iOS permission strings).
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
- `GnssPositionSource`:
  - **Fixes:** from `SensorService` (`modules/sensor-capture`: `BestForNavigation`, automotive, never paused by iOS).
    It registers as capture owner `position` while the map is on screen; a trip keeps GNSS running in the
    background.
  - **Mapping:** `GnssRecord` → `PositionEstimate` with `source: 'gnss'`; course → `headingRad`. Invalid
    speed/course (NaN) → undefined.
  - **Trust:** decided over time by `GnssTrustTracker` (`src/services/position/gnss-trust.ts`), not per fix, so
    intermittent jamming doesn't flicker it.
    - Only **satellite fixes** (they have a speed) count as good. Wi-Fi/cell fallback fixes never do, however
      accurate they claim to be (±7 m is common).
    - `'TRUSTED'` → `'NO_FIX'` when no satellite fix ≤ 50 m has arrived for 8 s.
    - `'NO_FIX'` → `'TRUSTED'` after satellite fixes ≤ 30 m have kept arriving for 5 s with no gap.
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
- `useKeepAwake()` while the map screen is focused.

### 6.2 Camera modes

`follow` → `follow-heading` (heading-up from the walking compass beam when shown, else GNSS course when speed > ~2 m/s, else north-up) → `free`. User pan/zoom gesture switches to `free`. `RecenterButton` cycles modes and shows the current one.

Tilt: the camera tilts to 50° (navigator view) while a trip is recording or when zoomed in to ≥ 16.5 (back to top-down below 16). It applies in every mode and returns to top-down while the ghost view is open. Pitch is set only when this rule flips, so a manual two-finger tilt stays until then.

### 6.3 Overlays — `src/components/map/`

One small component each. Touch targets ≥ 56 pt; high contrast; minimal text.

| Position | Component           | Content                                                                                    |
| -------- | ------------------- | ------------------------------------------------------------------------------------------ |
| Top      | `TrustBadge`        | `GPS OK` / `UNTRUSTED` / `REACQUIRING` / `NO FIX`, colored by trust state                  |
| Top      | `SinceTrustedStrip` | Time and distance since last trusted fix (`—` for now)                                     |
| Top      | `AdapterChip`       | Adapter status (mock: Disconnected); tap → `vehicle`                                       |
| Top      | `LowAccuracyBadge`  | Shown when calibration is `not-calibrated`; tap → `calibration`                            |
| Top      | `ManeuverBanner`    | Only with active route (see 7.1)                                                           |
| Bottom   | `SpeedReadout`      | Speed in km/h (GNSS speed)                                                                 |
| Bottom   | `RecenterButton`    | Camera mode cycle                                                                          |
| Bottom   | `MapToolbar`        | Route, Vehicle, menu → Downloads, Calibration, Debug, Settings (`Link` from `expo-router`) |
| Center   | `PermissionCard`    | Location denied → explanation + "Open Settings" (`Linking.openURL('app-settings:')`)       |
| Center   | `NoFixCard`         | "Waiting for GPS…" when no fix yet                                                         |

- Long-press on map → placeholder alert "Manual position fix — coming later" (real implementation with EKF, SPEC §3.4).

## 7. Phase 4 — Mock screens

Parallel with Phase 3; each screen is independent. Use `@expo/ui` for settings-like lists (see `expo-ui` skill).

### 7.1 `route`

- Search field filtering mock destinations (both EN and UK names).
- Selected destination → summary card: **real** straight-line distance and bearing from current position, mock ETA at 60 km/h.
- "Start" → sets `RouteContext` (`src/providers/route-provider.tsx`); map shows dashed straight line to destination + `ManeuverBanner` ("Head N toward Lviv · 12.3 km"). "Stop" clears it.
- Footnote: "Offline routing not available yet".

### 7.2 `vehicle`

- Adapter card: model OBDLink MX+, connection ExternalAccessory, status Disconnected, ELM327 version / OBD protocol / speed poll rate `—`, Connect button disabled.
- Odometry: VIN `—`; stage "1 · OBD speed + phone gyro".
- Live signals placeholders (`—`): speed (OBD), yaw rate.
- Yaw source: "Phone gyro". (Stage 2+ rows — wheel speeds, gear, profile — come with SPEC Phase 8.)

### 7.3 `calibration`

- Status: "Not calibrated".
- Steps with short explanation each: (1) standstill gyro bias 2–3 s with the phone in its mount, (2) straight segment ~300 m, (3) several turns.
- "Start" disabled; "Skip" visible (explains low-accuracy badge).

### 7.4 `downloads`

- Packs: "Map tiles — Ukraine", "Routing data — Ukraine" with mock size, version, status "Not downloaded"; Download disabled.
- Note: "Using online map (development)".

### 7.5 `debug`

- **Live** GNSS section: lat, lon, accuracy, speed, heading, fix age, update rate (Hz).
- Mock: integrity state, EKF state table (E, N, ψ, v, k_s, b_ω, k_ω), OBD polls/s.
- Logging toggle + Export button, disabled.

### 7.6 `settings`

- Language: System / English / Українська (persisted).
- Appearance: follows system (info only).
- Privacy statement (all data on device; dev-only online map exception).
- About: app version (`expo-constants`).

## 8. Verification

1. `npx expo lint`, `npx tsc --noEmit`, `npx jest` pass.
2. `npx expo-doctor` clean; EAS dev build installs on iPhone and connects to `npx expo start`.
3. On device:
   - Permission prompt appears, localized per device language.
   - Puck tracks while walking/driving; accuracy circle scales with reported accuracy.
   - Heading-up engages only when moving; pan → free; recenter restores follow.
   - Airplane mode / indoors → `NO FIX` within ~5 s.
   - Deny permission → `PermissionCard`.
   - Dark mode switches map style.
   - All sheets open/close; Ukrainian strings fit without overflow.
   - Route: select destination → distance plausible; Start → line + banner on map.
4. Debug GNSS values match the puck; update rate ≈ 1 Hz.

## 9. Out of scope (this milestone)

Background location; EKF, integrity, calibration logic; vehicle-link module (ELM327 / CAN); real routing and downloads; persistence beyond language setting; web and Android polish.
