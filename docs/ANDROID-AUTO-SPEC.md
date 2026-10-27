# wtf.ai — Android Auto: Specification

The map with the navigator's position, the route's guidance and a destination to pick, on the car's Android Auto
screen. Companion to [ANDROID-SPEC.md](ANDROID-SPEC.md); the iOS counterpart is the CarPlay spike (branch
`spike/carplay`, its CARPLAY-SPEC.md), whose split this follows: the map is the phone's React map, the car's own UI is
the platform's templates, and what they show is decided in TypeScript.

## 1. Goal

A navigation app on Android Auto: the car's screen shows the same offline map, dot and route as the phone, the next
maneuvers and the time left in Android Auto's navigation cards, and the saved and recent destinations to route to. The
dot is the navigator's (SPEC §3), never the phone's GPS: under jamming the car's screen is no help otherwise. Nothing
extra to install: Android Auto is part of Android, and the car's screen is part of the app.

## 2. What Google requires

| Need | Fact | Consequence |
| --- | --- | --- |
| A Car App Library navigation app | A `CarAppService` with the `androidx.car.app.category.NAVIGATION` intent category, the permissions `androidx.car.app.NAVIGATION_TEMPLATES` and `ACCESS_SURFACE`, `automotive_app_desc.xml` with `<uses name="template"/>`, `androidx.car.app.minCarApiLevel`. | `modules/android-auto`'s own manifest (merged into the app's; no config plugin). Car App Library 1.7.0 (stable); every template used is from API level 1, so `minCarApiLevel` 1. |
| Host validation | The service answers only hosts it trusts. | Release builds: the library's allowlist (`hosts_allowlist_sample`: Android Auto, Android Automotive OS's template host). Debug builds: any host (the Desktop Head Unit). |
| Distribution | Android Auto lists a Car App Library app in a car only when it was installed from a trusted source: Google Play, including internal testing and internal app sharing. Its developer setting "Unknown sources" covers other kinds of apps, not these (developer.android.com, *Test Android apps for cars*). The Desktop Head Unit lists a sideloaded build with developer mode and "Unknown sources" on (§5). | The sideloaded APK (ANDROID-SPEC §1) brings Android Auto to the desktop test, not to testers' cars. Testers get it in a car from the Play internal test track (the store build, SPEC §2.2). Not yet tried in a car. |
| Review | Production on Play needs the Android Auto form factor added in the console (Advanced settings → Form factors), Android Auto screenshots, and Android for Cars' app quality review for navigation apps (the NF guidelines). The location foreground service is declared for navigation already; its Android Auto use (§3) goes in that declaration too. | Open (§7). |

## 3. Session

```
Android Auto ─▶ CarScreenService ─▶ CarScreenSession (Kotlin, main thread)
                                      ├─ NavigationScreen: NavigationTemplate (turn card, trip card, buttons)
                                      │    └─ DestinationsScreen: ListTemplate (saved, recent)
                                      ├─ NavigationManager: the trip, for the host's own displays
                                      ├─ CarMapSurface: Surface ─▶ VirtualDisplay ─▶ Presentation ─▶ React root "CarMap"
                                      └─ CarSessionTask: headless JS task "WtfCarSession"
                                                 │
src/components/car-screen/car-session.ts ◀───────┘  route, places, words, voice, notice, search ─▶ AndroidAutoModule ─▶ CarLink ─▶ templates
                                                     ◀─ onCarAction (end-route, go, search, request, toggle-voice,
                                                                     confirm-held, cancel-held, permission, notes,
                                                                     session-ended)
```

- A **session** is one connection of the car's screen with the app opened there. Its JS side is a headless task, run
  for the whole session whatever the car shows: it can't live in the map's React root, which Android Auto destroys
  when the driver opens another app on the car's screen, and the guidance and the voice must go on then. React Native
  starts without an activity if the app wasn't open; a JS reload gets the task again in the new context. It ends on
  `session-ended`.
- Running, the task keeps React Native's timers firing with no activity in front (as `JsKeepAlive` does for trips),
  keeps the navigator and the phone's sensors running as on a trip (`Runtime.setCarScreen`), and connects the
  remembered adapter as the phone's app does when it opens. Trip log: `android auto connected`, `car screen on|off`,
  `android auto disconnected`, the driver's actions there, and the native side's notes as `android auto: …` (the map's
  surface, the location service, the permission asked, what failed). CarLink keeps those notes until the task takes
  them (`takeNotes`, at its start and on each `notes` action), since some come before a task runs or listens. A failure
  among them is also reported to Sentry (warning, tag `feature: android-auto`), since the trip log keeps notes only
  while a trip records.
- **The route** goes to the car at every change of the route service's snapshot (`carRoute`, pure, Jest-tested);
  the native side keeps the last state for whichever comes next (the session or the JS runtime). Each session's task
  sends all of it at its start, the notice too when there is none: a JS reload loses what JS held (a held route),
  while the car still shows what the runtime before sent.
- **One voice** however many screens show the route (`VoiceGuide` in use-voice-guidance.ts): the first screen to claim
  it speaks, the others follow the route in silence and take over when it lets go. The phone's map claims it while
  mounted (also in the background); with no phone screen (the app opened from the car) the car session speaks. Muted
  and the volume are the phone's settings, which the session applies as the phone's map does; the car's button toggles
  mute, and is gone at volume 0. The route's end stops what is being said.
- **The voice is navigation guidance** while the session runs: its clips play on Android's own player with
  `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` (`modules/audio-output` `playGuidance`, ROUTING-SPEC §8.5), which Android Auto
  mixes over whatever the car plays, its own radio too. As media they would be heard only with the phone as the car's
  source. A clip that won't play that way goes through expo-audio as media; the system voice (an announcement without
  clips) is media always. Without a car the voice plays as before.
- **Location permission:** without it (fine or approximate) the navigator has no GNSS and the car shows a notice
  instead of the route (§4): its button, parked only (`ParkedOnlyOnClickListener`), opens Android's permission dialog
  on the phone (`CarContext.requestPermissions`), and a toast on the car says to look at the phone only when it's safe
  (quality guideline VI-1). The task checks again on the dialog's answer, when the phone's app
  comes to the front, and every 5 s while the notice shows. Allowed: the notice goes, GNSS starts
  (`NavigatorService.retryCapture`), and `CarLocationService` starts if the car shows the app (else at the session's
  next start).
- **Without an adapter** (phone-only mode, no adapter connected; UI-SPEC §6.3): a destination picked on the car is held
  for the driver's word as on the phone (`route-without-adapter.ts`), and a route held on the phone shows on the car
  too. The car shows it as a notice: stop and set the position on the phone, or once it is set or GPS is trusted,
  keep to the route (checked every 5 s while it shows). The card has a short title and two short lines, cut beyond
  them in split screen: the car's words are its own (`car*` strings), one instruction at a time. Its button gives the word and starts the route; its
  close button drops it.
- **Places asked for** (navigation intents, quality guideline NF-6): Android Auto gives the car assistant's "navigate
  to" (and another car app's) to the navigator last opened on the car, as `androidx.car.app.action.NAVIGATE` with a
  `geo:` URI; `ACTION_VIEW` asks only to look. The module's manifest declares it on the phone's activity (merged into
  the app's), as Android Auto requires; the session gets it in `onCreateScreen` or `onNewIntent`, and CarLink keeps it
  until the task takes it (`takeRequest`, at its start and on `request`). Read as SEARCH-SPEC §4.6: a point is gone to,
  by the link's name; words are searched, and one answer gone to. Several, none, or asked only to look: the search
  screen opens with the words and the answers to pick from. Gone to as a destination picked: recent, held without an
  adapter. Trip log: `navigation asked for: <uri>`, then `place asked for on the car` or how many were found.
- **Words:** the app's language, sent again when the driver changes it and when the phone's app comes to the front
  (the system's language changed meanwhile).
- **Location**: Android Auto binds the app's service as a top app's binding, with the location capability while the
  car's screen shows the app (no activity, no permission beyond When In Use) and without it while it shows another
  app: GNSS stopped then. `CarLocationService`, a foreground service of the location type started when the car shows
  the app (the session's start; a session made while the car shows another app has nothing to keep yet), keeps it for
  the session, with a quiet notification in the app's language. It starts only with location permission (a service
  started for the foreground must go there, which a location service can't without it). A trip's own service
  (ANDROID-SPEC §3) is apart.
- **Teardown** is the current session's: a session ended after a new one began (the car reconnected) leaves the task,
  the location service and CarLink's session to the new one.

## 4. The car's screen

- **The map is React Native**: `CarMapSurface` makes a private virtual display on Android Auto's surface, with the car's
  size and density, and shows a `Presentation` on it whose view is the React root `CarMap`
  (src/components/car-screen/car-map-root.tsx) on the app's one React host. It renders the phone's `MapSurface`, so the
  style, dot, route and camera are the phone's and over-the-air JS updates reach the car. React Native and MapLibre lay
  out in the car's density (`ReactSurfaceImpl` takes it from its context). The root's props: the car's own day or night
  (`CarContext.isDarkMode`, not the phone's scheme) and the visible area as insets in dp: the camera keeps the dot in
  the part the cards leave free, low in it in heading-up (`useMapCamera` `insets`, below).
- **Two things React Native and MapLibre do for the phone's activity, undone for the car's display:**
  - React Native applies a render's changes to the views on display frames it stops when the activity pauses
    (`FabricUIManager.onHostPause`) and never starts without one. The car's map showed its first frame for good, only
    the camera (direct commands) moving. While the car's map shows, `CarFabricFrames` keeps them running and restarts
    them after each pause; after, they follow the activity again.
  - MapLibre's React Native map pauses and is destroyed with the activity. A map on another display ignores the
    activity (`patches/@maplibre+maplibre-react-native+11.4.0.patch`) and is disposed with its React view.
  - The same patch drops a camera command that arrives after a JS reload or an applied update has torn the React
    context down (`ReactTagResolver`; unpatched, a NullPointerException). The car's map sends one every frame, so it
    meets that window.
- The car's map follows heading-up, smoothed every frame as the phone's is in front (`useSmoothedPosition`'s
  `onScreen`), its dot 0.85 of the way down the visible map (the phone's: 0.8 of its whole map): a car's screen is wide
  and short. Google Maps keeps its arrow about 0.9 down on both.
- **Bigger, as Android for Cars asks** (map text off the roads 24 dp, markers 36 dp): the virtual display has the car's
  density × 1.4 (`CarGuidanceLogic.MAP_SCALE`, JUnit), so everything on the map is drawn 1.4 times the car's dp (the
  dot 26 → 36 dp), and the follow zooms are lowered by log₂ 1.4 to show the same ground. The insets are in the map's dp.
  Of the POIs only fuel and charging stations, and rail stations (the metro's too) and airports as landmarks to check
  the dot by; their names 24 dp, their icons 36 dp. No ways a car can't take (footways, steps, cycleways, pedestrian
  streets: in parks and yards their dashes were the busiest thing on the screen); service roads and tracks stay
  (`carMapStyle`, src/config/map-car.ts).
- **Templates** (`CarScreens.kt`), built from the last state the session sent:

  | State | NavigationTemplate shows |
  | --- | --- |
  | A notice: no location permission | Its message card, before any route; button: Allow (parked only) |
  | A notice: a route held without an adapter | Its message card; buttons: I'll follow the route, close |
  | No route | The map; buttons: Search, Destinations, voice |
  | Planning, or planning again after leaving the route | A loading turn card; buttons: Stop guidance, voice |
  | Followed | The next maneuver (the phone banner's words and icon, the distance rounded as the banner rounds it), the one after when it follows closely; the trip card (time and distance left, arrival time at the plan's pace); buttons: Stop guidance, voice |
  | Arrived, failed | A message card with the phone's words |

  Which card shows is `CarGuidanceLogic.card` (JUnit).

  Destinations: saved places (Home, Work, favourites) then recent ones, as many as the car allows; one picked routes
  to it as the phone's route screen does (and becomes recent).

  Search (`SearchTemplate`): each change of the field goes to the session, which searches the phone's offline index
  (SEARCH-SPEC §5, near the car) and sends the answers with the text they answer. The screen shows them only for the
  text in the field, loading meanwhile (`CarGuidanceLogic.searchList`, JUnit), as many as the car allows: what and
  where each is, and how far. One picked routes to it, as a destination does. The host offers the keyboard only while
  parked; a place the car's assistant asked for opens the screen with its words, the keyboard closed.

  The car's words are the app's (en/uk), sent by the session; English until it has.
- **The navigation session** (`NavigationManager`): started when a route is planned or followed, the trip (the steps
  ahead, each with its distance and time from the car; the destination) sent with each change, loading while it is
  planned; ended at arrival, a failure or no route. The host's "stop navigation" (another navigator started) ends the
  route.
- **Icons**: Material Symbols drawn as vector drawables by `scripts/car-icons.py` from the font the phone draws its
  icons with: the same arrows as the banner.

Must not drift:

- The car's map shows the navigator's position. No Google map, no car or phone GPS location layer: both show the
  jammed or spoofed GPS.
- Offline like the phone: the map packs, no network.
- Native stays thin (SPEC §6): templates, surfaces and sessions in Kotlin; what they show decided in TypeScript.

## 5. Testing: the Desktop Head Unit and the emulator

No Android device and no car: Android Auto runs on the emulator, the car's screen on the PC.

1. An emulator with Google Play signed in (Android 16, x86_64). Play refuses Android Auto on the emulator ("isn't
   compatible"); its arm64 bundle installs by hand over the system's stub (`adb install-multiple`), which only a
   Google-signed one can replace.
2. Android Auto's settings (`adb shell am start -n
   com.google.android.projection.gearhead/.companion.settings.DefaultSettingsActivity`): tap Version ten times for
   developer mode; ⋮ → Developer settings → Unknown sources on; ⋮ → Start head unit server (again after a cold boot);
   `adb forward tcp:5277 tcp:5277`. The first connection asks for notification access, which `cmd notification
   allow_listener` grants without the screens.
3. The Desktop Head Unit (SDK package `extras;google;auto`): `desktop-head-unit.exe -c config/default_720p.ini`. It
   takes console commands: `tap x y`, `screenshot <file>`, `day`, `night`. A newly installed build appears in the
   car's launcher after the head unit reconnects.
4. `adb emu geo fix` along the route the app logs as `wtf-demo-route` (debug builds) drives the car.

Checked this way (debug and release builds): the map, dot and route on the car with the phone's app in front, in the
background and with the phone's screen off; the app opened from the car with no activity (release: the embedded
bundle), the route resumed; the turn and trip cards following a drive; Stop guidance; Destinations and a route
started from the car; GNSS with another app on the car's screen; the car session's voice with no phone screen; the map
after another app was shown on the car's screen; Android Auto's split screen (a narrower surface, insets on both
sides); the car's night mode; the spoofed GPS shown as on the phone (the dot kept, its circle, the "GPS?" ghost).
Also (debug build): the location notice with the permission revoked, its Allow button opening the phone's dialog,
and after the grant the notice gone, the location service running and the dot on the car's map; a clip played with
the navigation guidance usage after a route started from the car (`dumpsys audio`); a destination picked on the car
in phone-only mode held as a notice, its button starting the route; a JS reload clearing a stale notice.

## 6. Not chosen

- **A native MapLibre map in Kotlin**, fed positions from JS: a second copy of the style, dot and route drawing, and no
  over-the-air updates for it.
- **Android Automotive OS** (the car's own Android): another build (`app-automotive`, `CarAppActivity`), cars few of
  the testers have; the same templates would serve it later.

## 7. Open items

1. A real car, from the Play internal test track (§2); there, the car's assistant (VC-1) asking for places.
2. Moving the map from the car: Android Auto's map buttons (pan, zoom, recentre) and gestures (`SurfaceCallback`).
3. A route's alternatives before following one (the route preview, ROUTING-SPEC §8.7).
4. The instrument cluster (`FEATURE_CLUSTER`) and turn-by-turn notifications while another app fills the car's
   screen.
5. The quality review's other navigation guidelines, before production: turn-by-turn notifications (NF-3, item 4),
   the cluster (NF-4), a test-drive mode that simulates driving (NF-7).
6. Debug builds need Metro as for the phone. A car's map started before the development launcher loaded the JS stayed
   blank; `CarMapSurface.restartIfStopped` starts it again in the new React context, not yet seen doing so.
