# wtf.ai — UI Specification

The screens and the map as built. Companion to [SPEC.md](SPEC.md) §3.8. Source of truth for coding agents working
on the UI.

## 1. Goal

A map-first app a driver can use with one glance and one tap while the car moves: the position and how far to trust
it, the route, and the car's connection; everything else one level down.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Builds | Release and dev-client builds from CI, sideloaded (SPEC §2). MapLibre does not run in Expo Go. |
| Map tiles | OpenFreeMap **Liberty** style on offline PMTiles of the active downloaded region (SPEC §3.7); no online map. |
| Navigation | **Map-first**: a full-screen map with floating controls; everything else is a page pushed on one root stack (§5). |
| Design | **Calm**: Onest type, frosted-glass map panels (`expo-blur` + translucent tint, `src/components/ui/glass-fill.tsx`), sentence-case trust status, a big light speed numeral. Tokens in `src/constants/theme.ts` (`usePalette()`), icons in `src/components/ui/icon.tsx` (Material names → SF Symbols / Material Symbols). Design sources: `docs/design/guide/`. |
| Language | English + Ukrainian. Default: the first device language the app speaks, Russian as Ukrainian; override in Settings. |
| Theme | System light/dark, or a fixed one from Settings (persisted); the map style switches too. |
| Units | SI internally; km/h, km/m and degrees only in the UI. |
| Privacy | Offline map only: no map requests while driving or browsing. The update Worker is contacted for the map catalog, downloads and app updates only. |

## 3. Position source

The map's position comes from `NavigatorService` ([NAVIGATOR-SPEC.md](NAVIGATOR-SPEC.md) §9), the runtime's
`PositionSource`; without OBD speed it shows phone GNSS, the held manual position, or phone-only mode. GNSS comes
from `modules/sensor-capture` (shared with the trip log), never `expo-location`'s watcher (it stopped for good after
jamming).

## 4. Foundations

### 4.1 Position types (`src/nav/position/types.ts`)

- `TrustState`: `'TRUSTED' | 'UNTRUSTED' | 'REACQUIRING' | 'NO_FIX'`; `PositionSourceKind`: `'gnss' | 'fused' | 'dr' |
  'manual'`.
- `PositionEstimate`: `lat`, `lon`, `headingRad?`, `speedMps?`, `accuracyM`, `source`, `trust`, `timestamp`,
  `lastTrustedFixAt?`, `distanceSinceTrustedM?`, `rawGnss?` (the ghost marker), `alternatives?` (other roads the car
  may be on), `mapMatch?`, `poseQuestion?`, `manual?`, `sinceDriverM?`, `parkedOffRoad?`.

### 4.2 Geo helpers (`src/nav/geo/`)

`haversineM`, `bearingRad`, `circlePolygon` and the rest of the geometry the map draws, pure TS.

### 4.3 Position service (`src/services/position/`)

`PositionSource`: `start()`, `stop()`, `subscribe`, `getSnapshot()`, permission status. The phone-GNSS source
(`gnss-position-source.ts`) maps `GnssRecord` → `PositionEstimate` (`source: 'gnss'`, course → `headingRad`, invalid
fields undefined). Trust is GNSS integrity's (NAVIGATOR-SPEC §8), the same with or without an adapter, decided over
time so intermittent jamming doesn't flicker it: only satellite fixes integrity passed count as good; `TRUSTED` →
`NO_FIX` after 8 s without one ≤ 50 m; back after good fixes ≤ 30 m for 5 s; `UNTRUSTED` while integrity refuses,
`REACQUIRING` once they come back. The map shows a fix once the navigator has taken it (300 ms after delivery); a
refused one only as the ghost. Trust changes go into the trip log.

### 4.4 React binding (`src/providers/position-provider.tsx`)

`usePosition()` via `useSyncExternalStore`; `usePositionPermission()`.

### 4.5 i18n (`src/i18n/`)

`en.ts` is the typed source of truth (`Strings`), `uk.ts` `satisfies Strings`; the guide's strings in `guide-en.ts` /
`guide-uk.ts`. `useT()`; locale from `expo-localization` (`system-language.ts`); the override (`system | en | uk`)
persisted in kv-store. No hardcoded user-facing strings in components.

### 4.6 Theme and map config

- `src/constants/theme.ts`: light and dark palettes (`bg`, `text`, `accent`, `route`, `routeAlt`, `routeCasing`,
  `maneuver`, `puck*`, status colours `ok` / `warn` / `bad` / `idle`, …), `usePalette()`.
- `src/config/map.ts`: the active region's offline style (`useMapStyle(scheme)`, `hasUsableMap`, `withAttribution`),
  with the world drawn around it (`map-world.ts`) and street-level labels (`map-labels.ts`): house numbers from z15
  (the tiles' `housenumber` layer, which Liberty doesn't draw, above the buildings and below every other label) and
  shop and other POI names from z16, not Liberty's z15, without the POIs of no use to a driver (bins, recycling,
  playgrounds, pitches, bicycle parking, shelters, bollards, information boards, drinking water, artworks);
  `map-dark.ts` re-tints Liberty for the dark scheme (Night Drive: near-black ground, amber primary roads, orange
  motorways and trunk roads, dark road names on a white halo, quiet grey house numbers);
  `map-palette.ts` reads the style's colours for the guide's drawn maps.

### 4.7 Text size, system bars and orientation

- **`T` scales itself** (`src/components/ui/text.tsx`): font size and `lineHeight` by the same factor, capped (a fixed
  `lineHeight` on Android grows by the full factor and text came out double-spaced). Text up to 18 pt grows by the
  whole factor, larger text by the points 18 pt gains.
- **Caps:** pages 150 % (`MAX_FONT_SCALE`); the map screen's panels 130 % (`FontScaleLimit`); the Guide's drawn maps
  115 %; text fields 125 %; the speed numeral 120 %. React Native's own `Text`/`TextInput` outside `T` carry
  `maxFontSizeMultiplier` (a Jest test holds every one to it); icons don't scale.
- **One line that shrinks** (`T fit`, down to half): button, chip and bar labels, page titles, list-row titles. Two
  lines then shrinking (`fit={2}`): the status pill's lines, the route banner's instruction, onboarding's buttons.
- **Side by side while it fits, else stacked** (`flexWrap`): a card's two buttons, a row's label and value, the
  adapter's name and its button, a region's name and state, a saved-place message and its Undo. A number and its
  unit never part at a line end.
- **System bars:** Android draws edge to edge, so every screen pads itself by the safe-area insets. The map's bottom
  bar sits fully above Android's navigation bar; iOS lets it reach into the home indicator's strip. The status bar
  icons follow the app's scheme.
- **Orientation:** portrait only (`app.json`). **The map turns with the phone** (`map-turn.ts`): held sideways or
  upside down, only the map view is rotated 90°/180° about the screen's centre, from the IMU's gravity, so north-up
  has north at the physical top; the panels stay. A new turn holds 0.7 s, ±15° of hysteresis past the diagonal, kept
  while the phone lies flat; `map turned <deg>°` goes into the trip log. Not on Android 10–11 (a GLSurfaceView can't
  be rotated).
- **Tablets** (Android 16 ignores the portrait lock at 600 dp and wider; a tablet's natural orientation is landscape):
  the system turns the window itself. Gravity for the map turn is taken in the screen's frame (`screenGravity`, by
  `Display.getRotation`: `useDisplayRotation`, also told of a 180° flip, which keeps the window's size), so the map
  turns only where the window didn't; the walking compass adds the same rotation. The map's panels stop at
  `PanelMaxWidth` (520), a page's body and the full-screen modals at `PageMaxWidth` (640), centred: a wide window keeps
  a phone's proportions, the map showing around the panels. Must not drift: a phone never reaches either width, and
  a badge or anything placed on a stretched element anchors to its content, not to the element's edge.

## 5. App shell

- `src/app/_layout.tsx`: `Stack` inside `ThemeProvider` → `I18nProvider` → `PositionProvider` → `RuntimeProvider`
  (`src/services/runtime.ts` creates the services once).
- **Pages, not sheets:** everything opened from the map (Route, Vehicle, Offline maps, More and what it opens, the
  Guide and its lessons, the developer pages) is a page pushed on the one root stack, sliding in from the right, so
  going back is the system's (the edge swipe on iOS, the back gesture or button on Android). The page header
  (`ScreenContent`) has a back button, and from the second level down a ✕ straight back to the map.
- **Full-screen modals**, with nothing to go back to: `onboarding` (welcome → location → adapter → keep the position without the app (VEHICLE-LINK-SPEC §11; an install from before that step gets it once by itself, `?only=wake`, never during a trip; the Vehicle screen's same offer is hidden until onboarding is done) → phone holder; shown
  until kv-store `onboarding-done`), `map-setup` (the first map download) and `adapter-firmware` (a new adapter's
  firmware check, over whatever is open: VEHICLE-LINK-SPEC §8.4).

## 6. Map screen (`src/app/index.tsx`)

### 6.1 Map

- Full-screen MapLibre map in the active region's style. Read the MapLibre RN docs for the installed version before
  coding.
- **Custom puck** from `usePosition()` via a GeoJSON source and layers: dot + heading cone (only with a heading) +
  accuracy circle. Never MapLibre's built-in user location. The dot (`puck-style.ts`): an 8 pt fill, a 3.5 pt ring and
  a 1.5 pt dark edge outside it. Trusted GPS: a blue fill in a white ring (light #0A84FF, dark #3D6BFF); otherwise the
  theme background in an amber ring (`puckDoubt`). In dark the trusted dot glows (a soft disc 10 pt past the edge at
  45 %). The cone is 34 pt long, 28° each side, the same on screen at every zoom and tilt (built in screen points and
  laid on the ground for the camera), filled at 32 % and outlined as the dot. Pins and marks are banded the same way;
  the placing pin (`placing-pin.tsx`) is one component on the map and in the lessons. `map-contrast.test.ts` holds
  everything the app draws on the map to 3:1 against every surface under it, in both themes.
- **Compass heading** (display-only, `useCompassHeading`): not in a car (no trip, adapter not connected) and speed
  < 3 m/s, the cone comes from `watchHeadingAsync` and shows where the phone points, as wide as the compass is unsure
  (20°/35°/50°/60° for accuracy 3–0). It never reaches `PositionEstimate`.
- Raw GNSS **ghost marker** from `rawGnss`, hidden while `source === 'gnss'`.
- **The parked car** (`useParkedCar`, `ParkedCarLayers`): while the car isn't the dot (no speed from it for 10 s: the
  driver walked off, the app opened elsewhere), its stored parked pose (NAVIGATOR-SPEC §6.1) is drawn as a car seen
  from straight above (`MAP_CAR`, `puck-style.ts`; drawn by `scripts/map-car.py` into one sheet,
  `assets/images/map-car-sprite.png`, a second sprite of the map's style, `car-sprite.ts`, loaded with it): shaded to read as 3D, its body dark on the light map and white on the dark one, the windscreen
  and windows in the trusted dot's blue, banded as the dot (a white ring, a dark edge, black round the white car), a
  soft shadow; nose the way it was parked, facing the screen when the map tilts, under the pins
  and the dot. It grows as the map is zoomed in, at half the map's rate (56 pt long at zoom 17, twice that at 19),
  never below 28 pt nor shorter on the ground than a real car (5 m). Zoomed in past the screen's own image (1x–3x), a
  denser one is drawn (6 and 12 px a point), so the car stays sharp at real size. Not while the car answers (the dot is the car),
  once it drives (the pose is cleared), nor in phone-only mode. The phone's fixes away from the car never move or drop
  it. A confirmed placing (§6.2) is drawn instead while it stays: one car on the map. **Standing on it**, when the
  dot's disc touches the car on screen, the dot and its cone give way to the car (its circle stays) until the dot is
  8 pt clear of it.
- **Map-match alternatives** (`alternatives`): hollow markers under the puck, more opaque the heavier they are.
- **Test tools** (Developer, off by default): the particle overlay (MAPMATCH-SPEC §11) and the "Cut GPS" chip; while
  it is on, a card replaces the trust alert with the time, distance, the dot's distance from the withheld fix and
  "Restore GPS" (NAVIGATOR-SPEC §9).
- **Navigate without an adapter** (Developer, off by default): with no OBD speed and GNSS not trusted, the dot is the
  phone's own dead reckoning (NAVIGATOR-SPEC §9.6), drawn as `dr` with its alternatives; its circle over 75 m, or
  5 km since its start, a placing or a trusted fix, offers the placing chip.
- **Map data credit:** MapLibre's (i) button, bottom left, level with the camera button, opens "© OpenStreetMap
  contributors · © OpenMapTiles" with links; Settings → About repeats it.
- `useKeepAwake()` while the map screen is focused.

### 6.2 Camera modes and the dot's motion

`follow` (north up), `follow-heading` and `free`: a pure reducer (`camera-policy.ts`) fed by `useCameraMode`.

- **The driving view** is `follow-heading`, unless the driver toggles to `follow` with the button during the trip
  (then `follow` for the rest of it). The next trip drives heading-up again.
- **Driving** (a trip recording, speed > ~2 m/s for 2 s): north-up `follow` and the app's own `free` views (a new
  route's alternatives, placing the car) become the driving view at once; a look around (a pan/zoom) once the map
  hasn't been touched for 10 s. Standing, `free` stays.
- **The button** (`CameraButton`): from `free` always `follow-heading`, then between `follow-heading` and `follow`.
- **The trip ends**: `follow-heading` goes back to `follow`, unless the driver toggled during it.
- Into the trip log: every mode (`camera <mode>`) and the policy's own changes (`camera <mode> by itself: …`).
- **Heading-up bearing:** the walking compass when shown; else the navigator heading (`dr`/`fused`, valid while
  stopped); else GNSS course when speed > ~2 m/s; else the last of these held. No direction known while standing:
  heading-up keeps its camera (zoom 17, tilted) and the map keeps its bearing. Moving without one (anchored under
  jamming): the `follow` camera (zoom 16, flat, north up) until there is one. The bearing goes to the map in
  [0°, 360°).
- **A wide circle at open:** until the car first moves after the app opens, the follow camera zooms out (half steps,
  not below 9) until the position's circle has a radius of at most 35 % of the screen's narrower side, and back in as
  it shrinks. A circle that fills the screen reads as a tint, not as a circle. Once the car has moved, the follow
  zooms are fixed. Logged as `camera follow: zoom <z> to fit the circle (<m> m)`.
- **Tilt:** heading-up 50°; north-up, free, the ghost view, the routes' overview and placing are top-down. No tilt or
  rotate gesture. A gesture that leaves heading-up flattens the map once it settles. Names along streets and rivers
  stand up facing the driver (`text-pitch-alignment: viewport`): lying on the tilted road they blurred.
- **Where the dot sits:** heading-up puts it 80 % down the map's own height (a top padding on the follow stop), so the
  road ahead fills the screen between the route banner and the bottom bar: about 88 % of the map between them, where
  Google Maps keeps its arrow. The car's screen: 85 % of its visible map (ANDROID-AUTO-SPEC §4). North-up, and heading-up zoomed out for a
  wide circle at open, keep it centred. iOS reports the screen's centre as the map's, so the settle-back check below
  allows 1 km more while the dot is lowered.
- **Motion** (`pose-smoother.ts`): moving (≥ 2 m/s, with a heading, not a placed position) the dot, its circle and
  cone and the following camera are drawn ~30 times a second in even steps (every second 60 Hz frame): between the
  navigator's 2 Hz positions the pose goes on along the heading at the speed (≤ 1 s), the gap to each new position
  closes with a 250 ms time constant, and the camera follows frame by frame (`jumpTo`). A step over 80 m or a turn
  over 90° is shown at once. Only while the app is active: in the background a `requestAnimationFrame` loop spins the
  JS thread flat out and iOS kills the app for CPU. Standing, positions are drawn as they come, each eased over
  450 ms; a step over 80 m is a snap and the camera jumps to it. Leaving follow clears the last centre. The map opens
  on the active region's bounds and the camera follows only once the style has loaded; while following, a view the
  map settles on by itself more than 80 m from the dot is put back on it, once per follow stop (iOS applies the
  initial view at the first layout, after the style has loaded).
- **The parked-pose question** (NAVIGATOR-SPEC §6.1): a card under the status pill, "Is the car where the dot is?",
  with how far Wi-Fi puts it: "Yes, it's here" keeps the dot, "No" moves it to the Wi-Fi position and starts placing
  there. Asked only while the dot is the navigator's; it goes the moment it is answered and never blocks the map.
- **Putting the car on the map** (NAVIGATOR-SPEC §6.2): while standing, without GPS and with nothing vouching for the
  dot, a chip "Set your position on the map"; "No" to the pose question opens it too. The map zooms in (18, flat,
  north up) with a centre pin and a card ("Where is the car?" · Cancel / Here), then "Which way does it face?": a tap
  draws an arrow from the pin, another tap turns it (Cancel / Confirm; Confirm needs a tap). Moving off cancels. The
  confirmed placing is drawn as the car (the parked car's icon, §6.1, nose the way it was aimed, in place of the
  parked car) until the dot is 50 m away or the car is placed again. When the ignition
  comes on while the chip is offered, the voice says once, within 2 min, "Show on the map where the car is"
  (`place-car`; not when muted or at volume 0), on the phone's own speaker on Android (`playOnSpeaker`); on iOS where
  the voice goes, and once more 2 s after the audio moves off the phone within 20 s, while the chip is still offered.
- **The vehicle button's dot** (`use-nav-status.ts`): green when the car answers and is known (VIN read or
  remembered); yellow while connecting, searching the protocol, with the car off or not answering, or the VIN still
  asked; red with no adapter, an error, a car whose VIN never came, or yellow for 25 s in a row (`BADGE_BUSY_MAX_MS`,
  counted from the link's `tryingSinceMs`; pulsing meanwhile). While a trip records the button reads "Driving" in
  the accent colour. On the vehicle screen the adapter's button reads "Stop searching" while waiting, "Disconnect"
  once it answers. While the adapter searches all protocols, a chip "Finding the car's protocol…" under the pill.

### 6.3 Overlays (`src/components/map/`)

One small component each; the screen only places them and wires their state. Cards share `hud-card.tsx` (`HudCard`,
`HudChip`, buttons, the panel style). Touch targets ≥ 56 pt; high contrast; minimal text.

| Position | Component | Content |
| --- | --- | --- |
| Top | `StatusRow` | The status pill: the trust state in words, coloured by it ("Position trusted", "GPS looks spoofed", "GPS is back — verifying", "No GPS signal", and "Approximate location" when the only position is a Wi-Fi/cell one), the source ("GPS", "Car sensors", "Phone sensors only", "Verifying GPS", "Set on the map"); user-facing text uses GPS rather than GNSS. The speed in km/h beside it. A tap unfolds the details: the alert text and the last trusted fix's strip, the outage card and "Cut GPS", the manual position's chip |
| Top | `SinceTrustedStrip` (`trust-cards.tsx`) | Unfolded under the trust alert, while GNSS isn't trusted, from a minute after the last trusted fix: "Last trusted GPS: 4 min ago, 2.3 km back" |
| Top | `RouteBanner` | Only with a route (below) |
| Top | `trust-cards.tsx`, `placing-cards.tsx` | Trust alert, simulated outage, the parked-pose question, placing (`usePlacing`), "Are you still here?", the manual chip |
| Top | `RegionPromptCard`, `HudChip` | Outside the region (below), protocol search |
| Bottom | `destination-cards.tsx` | Dropped pin (`PinCard`), a route held without an adapter (`HeldRouteCard`) |
| Bottom | `CameraButton` | Camera mode (§6.2) |
| Bottom | `BottomBar` | Route, Vehicle (with the connection dot; "Driving" while a trip records), More (a red dot while an app or map update waits, UPDATES-SPEC §5.4) |
| Center | `PermissionCard` (`center-cards.tsx`) | Location denied → explanation + "Open Settings" |
| Center | `NoFixCard` | "Waiting for GPS…" when no fix yet; "GPS puts you outside Ukraine" + Set position when the phone's last location is abroad |

- **Outside the region** (`region-prompt.tsx`): when the position (any fix to 5 km, Wi-Fi ones too, not one suspected
  of spoofing) is more than max(1 km, its accuracy) outside the active region's outline (`region-check.ts`), a card
  "Outside <region>" offers **Switch map** to a downloaded region that has the car, else **Download** the smallest
  catalog region that has it, else Offline maps. "Not now" hides it for that pair of regions until restart. Hidden
  while that region downloads.
- **Long-press on the map** drops a pin; a card names what is there at that zoom (`pin-pick.ts`). Where the map draws
  buildings (from z13): on a building its house (the nearest within 75 m, SEARCH-SPEC §5); off one (a road, a yard)
  the street drawn under the finger (an all but invisible layer of the tiles' named street lines: MapLibre doesn't
  query a layer it doesn't draw), else the nearest house. From z9 the settlement, below that "Dropped pin". The pin
  keeps its exact point for Route here and I'm here. Then its distance and direction, ✕, **Route here** (ROUTING-SPEC §8), and **I'm here** (at any speed): placing
  starting at the pin.
- **With a route** (`src/components/route/route-banner.tsx`): the next maneuver's icon, the distance to it (10 m
  steps under 300 m, 50 m under 1 km), its instruction, "then …" when the next follows within 120 m, and the
  distance, time and arrival clock left; or "Planning route…", "Off route, planning again…", "Position uncertain:
  keeping the route", "No route" with the reason, "You've arrived". While the planner works a thin bar sweeps under
  the text (amber for a re-plan), and for a first plan a ring pulses out of the icon; both hold still with Reduce
  Motion. Its × ends the route; its speaker button mutes the voice (hidden while the volume in Settings is 0),
  holding it opens the system's audio output picker, and while the voice goes off the phone it shows the AirPlay
  audio glyph. Both buttons are 38 pt, on the distance's line (the title's, without one): the speaker right after the
  distance, the × in the corner, far apart. The lines under it take the card's whole width and the card stays low.
  The map draws the route ahead of the car (from its progress point: what is driven disappears; faded while planning
  again; the stretch from the progress point to the next vertex dashed over its solid outline), its next maneuver and
  the destination. Light: indigo #3D5CBC with an
  off-white outline; dark: cyan #00D4FF with a black outline, the next maneuver's dot white ringed in black. Widths
  (`ROUTE_LINE`): a 9 pt line in a 13 pt outline, dashes 18 on 8 off. **Alternatives** (ROUTING-SPEC §8.7): quieter
  solid lines under it (light #B8C7EE in a #53618A casing; dark grey-blue #93ABC4 in the route's outline), each
  labelled with its time against the route ("+4 min", "−2 min", "Same time"); a tap follows it; when they come while
  the car stands the map frames all routes once.
- **A route without an adapter** (phone-only mode on, no adapter): **Route here** and **Start guidance** don't plan
  at once. The destination is held (`route-without-adapter.ts`) and a card says where the position comes from (GPS
  has it; set on the map {age} ago; or "set your position on the map while the car stands" with **Set position**),
  then "follow the route exactly: the app keeps track of the car by its turns, and a turn off the route loses it".
  The route is planned only on **I'll follow the route**; its ✕ drops it.

## 7. Pages

### 7.1 `route`

- Field empty: **Saved** (Home, Work, favourites; `places-store.ts`, kv-store `places.saved`), **Recent** (the last 10
  destinations, one per place within 30 m; "Clear recent"; `places.recent`), **Cities · <region>** (the region's 8
  largest cities from its search index, else the built-in list inside the region's bounds).
- Typing: with the region's search index (SEARCH-SPEC §6), places, streets, house numbers and POIs, each with what it
  is, its settlement, distance and direction; without one, the cities filtered by name and a note to download the
  region again. Coordinates or a map link (SEARCH-SPEC §4.5): one result, its card straight away when pasted.
- Opened by another app's `geo:` link (Android, SEARCH-SPEC §4.6): over the map, its place or words in the field.
- A selected result → summary card: straight-line distance, bearing and time at 60 km/h; once its route is planned,
  the road distance and time. Under it **Home**, **Work**, **Save** (a place is saved under one kind), or "Saved as
  Home · Remove"; a confirmation strip with **Undo**.
- "Start guidance" plans from the position (`runtime.routes`, `useRoute()`) and returns to the map; "Stop guidance"
  ends it. **I'm here** on the summary card, at any speed: placing starting at the place
  (`place-request.ts`).
- Footnote: long-press the map to route anywhere or to say the car is there; routes stay inside the region.

### 7.2 `vehicle`

The car only: TRIP-LOGGER-SPEC §9.1.

### 7.3 `more`

How to use? (the Guide, §7.7), Offline maps (`more/downloads`), App update (`more/update`, UPDATES-SPEC §5.5; its row
and Offline maps' carry the update dot), on Android **Waze and Google Maps** (`more/navigators`, ANDROID-SPEC §8: the
switch, what sharing does now, the one-time setup as a checklist with buttons into Android's settings, "Open Waze",
"Check what they get", and what to know; its row says Off, On, Sharing (green) or Setup not finished (amber)),
Settings (§7.6); then the diagnostic pages Trip recorder (`more/recorder`,
TRIP-LOGGER-SPEC §9.2) and Developer (`more/developer`: the switches of TRIP-LOGGER-SPEC §9.2, the ELM terminal, the
**UI gallery** (`more/ui-gallery`): every panel the map shows only in some state, drawn at once with made-up data, to
see them all at a large text size and in both languages). In a store build the Developer row is hidden until seven
taps on the version in Settings (SPEC §2.2).

### 7.4 `downloads` (Offline maps; `src/app/downloads.tsx`, also `more/downloads`)

Regions of the newest map release from the update Worker: download, pause, resume, delete, switch the active one,
update; the active region also updates by itself or asks (UPDATES-SPEC §5.2). Tapping anywhere on a region's row
downloads it, or switches to it once downloaded. A region downloaded for the first time becomes the active one when
it is installed, or during a trip or a route once it is over (switching by hand first cancels that); an update leaves
the active region as it is. Until a region is usable, `map-setup`
(full-screen, no close; after onboarding) shows the same list under "Download a map" and closes itself once a region
is installed; deleting the last region brings it back.

A dropped connection (a timeout, a stream cut off; not an HTTP error or a bad checksum) never throws the download away:
it shows "Connection lost. Keep the app open — the download will resume automatically." and goes on after 5 s, 30 s and
2 min while the app is in front, and at once whenever it comes back to the front or starts again, unless the driver had
paused it (an automatic update waits for its own network rules). Android goes on from the bytes on disk (a `Range`
request from the part file's length), iOS starts the cut file again; the files fetched before it stay. Android cuts a
background app's network, so a whole country used to fail and start from zero until the app stayed open (2026-10-23/24).

### 7.6 `settings`

Language (System / English / Українська); Appearance (System / Light / Dark); Voice volume (ROUTING-SPEC §8.5); Car:
**Precise speed from the car's data bus** (the wheels; on by default; VEHICLE-LINK-SPEC §16.3) and, with it, **Detect
turns using the car's data bus (experimental)** (NAVIGATOR-SPEC §5.4) and **Send anonymous car reports** (on by default;
VEHICLE-LINK-SPEC §16.5), each with a line on what it does (turns: requires a compatible car and adapter, and the Car
page must show Turn detection: Car data bus; otherwise keep the phone in a holder, ABS alone being no guarantee
of support, nor working precise speed readings a guarantee of turn detection; the wheels' also says few cars carry
them at the OBD port yet, and,
with `SUPPORT_EMAIL`, "Write to us": the support email, with the car and adapter to fill in); Privacy: the statement
(position data on device; maps and app updates from the project's own server; crash reports and car reports without
location or personal data; the opt-in trip log upload in the Trip recorder; a store build's variant) and the **Privacy
policy** link (`privacyPolicyUrl(language)`); About: version with its build number ("1.0.0 (3563887)"), the app code
(the JS commit, built in or an update), the support code (the install id testers send), the map data credit; **Contact
support** (`SUPPORT_EMAIL`, the support code and version in the subject) when configured.

### 7.7 Guide (`guide`, `guide/lesson`)

How to use the app, for drivers. Design sources: [design/guide/](design/guide/). Strings in `src/i18n/guide-en.ts` /
`guide-uk.ts`; driver advice is an action ("Keep driving normally"), never "Nothing".

- **Onboarding** ends with a phone holder step (the gyro is the only yaw source without GPS): a firm holder, any
  angle, a phone picked up catches up; a note asks for the lessons before the first drive.
- **Map tour** (`map-tour.tsx`): offered once on the map after onboarding and the first map (a card above the camera
  button, hidden while a pin, a placing or the pose question is up; kv-store `guide.tour-offered`), and from the
  Guide at any time. The screen dims except one control at a time, with a card (step, title, text, Back / Next,
  Skip): the status pill, the dot, press and hold (a pulsing ring), the camera button, Vehicle and More. Three stops
  are tried for real (their hole lets touches through: the pill unfolds, a long press drops a real pin, the camera
  button switches) and the card adds a ticked line once done. Done ends with the lessons offer.
- **Lessons offer** on the map after the tour, in its place: Not now / Start lessons. Only while no lesson is done,
  the car stands with no trip or route, and nothing else is up; Not now hides it until the next start, at most three
  times (`guide.lessons-invite-dismissed`).
- **Guide** page: the first row of More, "How to use? · {done} of {total} done" ("Start here before your first drive"
  until a lesson is done); the tour card; until all are done, a card with Start lessons / Continue: {next lesson}; the
  lessons in groups (Getting started, When GPS fails, Routes, Maps) with a tick once done (`guide.done`); "Show the
  first-run screens again".
- **Lessons** (`guide/lesson?id=`), full pages, each interactive, on drawn maps (`react-native-svg`, `mini-map.tsx`)
  in the map's own colours (`useMapPalette`): never the live map, so practising never moves the car. The button at the
  bottom marks the lesson done and opens the next. The Guide lists only lessons that exist (`lesson-bodies.tsx`):
  1. **Before you drive** (`before`): the map and the adapter read from the app, the holder, opening the app first,
     the dot on the car and charging. The dot ticks itself while GPS is trusted; otherwise Show me opens the placing
     lesson.
  2. **What the dot is telling you** (`dot`): the five trust states on one map.
  3. **Put the car on the map** (`place`), two tabs with numbered steps under their maps: *Set the position* (no GPS,
     or the dot on the wrong road: the chip, or a long press anywhere → I'm here; the map dragged under the centre
     pin, Here, a tap for the heading, Confirm; it leads to the right answer with a target circle and Here only with
     the pin in it) and *When you set off* ("Is the car where the dot is?", both answers, and "Not sure": leave it,
     the question goes once GPS settles it). While placing, the page's back swipe is off and Android's back cancels
     the placing (`placing-map.tsx`).
  4. **The car button** (`car`): its four states, a checklist when red.
  5. **Driving through jamming** (`jamming`): a drive played in five stages (GPS ok, jammed, 4 min, a turn, GPS back;
     4 s each), with or without the adapter.
  6. **Plan a route** (`route`): a long press drops the pin (I'm here, then Route here) or search a saved place; the
     drawn map is a real road network (`route-map.ts`, `MemoryRoadGraph`): the app's router plans on it, the real
     banner shows the maneuvers and the voice says the first one.
  7. **Spoken directions** (`voice`): the real banner on a planned route (tap mutes, long press opens the output
     list) and the volume slider, for the lesson only.
  8. **Offline maps** (`maps`): the Offline maps screen as drawn there, with the phone's own regions; downloads,
     switching and deleting are pretend.

  The lessons draw the map's own pieces: its status pill, puck (blue when trusted, else amber with a dashed circle;
  the cone along the road, nudged by turning the phone), cards, chips and bottom bar.

## 8. Verification

1. `npx expo lint`, `npx tsc --noEmit`, `npx jest` pass (including `map-contrast.test.ts` and the font-scale test).
2. On device: the permission prompt is localized; the puck tracks while walking/driving and the circle scales with
   accuracy; driving off on a trip turns follow into heading-up, a stop holds the heading, a pan → free, the button
   restores follow; airplane mode → no fix within ~8 s; denied permission → `PermissionCard`; dark mode switches the
   map style; every page opens and goes back by the system's gesture; Ukrainian strings fit.
3. At a large text size on the Android emulator: `python scripts/android-ui-sweep.py out-dir` opens every page, the
   UI gallery and every lesson at 100 %, 130 % and 200 % text, scrolls each to the end and screenshots it, and fails
   when text or a button reaches under the navigation bar or a label spills out of its button. Run it in both
   languages and look through the screenshots. Onboarding and the map download are checked by hand.
4. Route: a destination → a plausible distance; Start → line, alternatives and banner on the map.
