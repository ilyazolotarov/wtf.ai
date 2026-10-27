# wtf.ai — CarPlay: Specification

The map with the navigator's position, the route's guidance and a destination to pick, on the car's CarPlay screen.
Companion to [ANDROID-AUTO-SPEC.md](ANDROID-AUTO-SPEC.md), which is ahead: CarPlay is the same car screen on iOS, and
what it shows is decided by the same TypeScript. **Status:** branch `feature/carplay`; the map and the turn panel work
on the simulator (§4, "Built"); the rest is the Android Auto feature list still to bring over (§4, "To build"). §7
lists what must be settled before `main`.

## 1. Goal

A CarPlay **navigation app** that does what the Android Auto app does: the same offline map, dot and route as the
phone; the next maneuvers and the time left in CarPlay's guidance panel; saved, recent and searched destinations to
route to; the voice through the car. The dot is the navigator's (SPEC §3), never the phone's GPS: under jamming the
car's screen is no help otherwise.

## 2. What Apple requires

| Need | Fact | Consequence |
| --- | --- | --- |
| Entitlement `com.apple.developer.carplay-maps` | Granted by Apple to the paid Developer Program account (team `EHLQ6P5XNP`) as a managed capability, for an app whose main purpose is turn-by-turn navigation. One CarPlay app type per app: Apple supports no other combination with navigation (only EV charging with fueling). | The App ID `ai.wtf.navigator` has **CarPlay Navigation** on, and nothing else of CarPlay. Fuel and charging stations on the map, the voice and the destination search are part of a navigation app: no Fueling, EV Charging or Audio capability. |
| A signed build carrying it | The App Store provisioning profile in `IOS_PROFILE_BASE64` carries the entitlement; the repository variable `CARPLAY_ENTITLEMENT=1` makes `modules/car-play/app.plugin.js` claim it. A capability changed on the App ID invalidates the profile: make it again and replace the secret, or the store build signs with nothing (SPEC §2.2). | CarPlay reaches phones through TestFlight (`build-ios-store.yml`) only. The sideloaded IPA is unsigned and re-signed by AltStore with a free Apple ID, whose profiles can't hold the entitlement: **no CarPlay there**. |
| Testing without a car | The iOS Simulator (I/O → External Displays → CarPlay) takes the entitlement from the entitlements file, no profile. Apple's standalone CarPlay Simulator needs a real iPhone on a Mac's USB. | Development on a Mac with the Simulator (§5). In a car: TestFlight. |
| Review | CarPlay apps follow the CarPlay App Programming Guide's guidelines for navigation apps on top of App Review. | Open (§7). |

## 3. Scenes

CarPlay draws in a `CPTemplateApplicationScene`, so the app adopts the UIKit scene life cycle:

- **SDK 57**: `ios.enableSceneSupport` in expo-build-properties (app.json). Prebuild moves the window out of
  `AppDelegate` into Expo's `EXExpoAppSceneDelegate`, which creates it when the phone's scene connects and starts
  React Native into it. **SDK 58** makes this the template's default (the iOS 27 SDK requires it): the costs below
  come with the next SDK upgrade whether or not CarPlay ships.
- `modules/car-play/app.plugin.js` adds the CarPlay scene beside the phone's (`WTFCarPlaySceneDelegate`),
  `UIApplicationSupportsMultipleScenes` (phone and car at once) and, with `CARPLAY_ENTITLEMENT=1`, the entitlement. It
  runs after expo-build-properties whatever the order in app.json (that plugin refuses a manifest it didn't write).
  Jest: `modules/car-play/__tests__/app-plugin.test.ts`.

What the scene life cycle breaks, to fix before `main`:

1. **Launch options are nil** in a scene app. `VehicleLinkAppDelegate` reads `.bluetoothCentrals` to create the
   central at once when iOS restored the adapter's connection, and `AppHealth` reads the launch reason behind
   `launchedOnTheWay` (index.ts, VEHICLE-LINK-SPEC §11). Apple's advice for scene apps: create the central with the
   restore id at every launch and take the restoration from `willRestoreState`; the location relaunch from the
   location manager's own callbacks.
2. **React Native starts with the phone's scene.** A background launch (location relaunch, Bluetooth restoration) is
   expected to connect no scene, so no JS runs and the drive wake doesn't happen (to verify on the phone). Fix: start
   the host on such a launch from an app delegate subscriber, with a root that renders nothing, the way the car's
   screen starts it (§4).
3. Links (`wtfai://`, `geo:`, universal links) and quick actions are forwarded by Expo's scene delegate; check them
   once.

## 4. The car's screen

```
CarPlay ─▶ WTFCarPlaySceneDelegate ─▶ CarPlaySession (Swift, main thread)
                                        ├─ CPMapTemplate (root): map buttons, nav bar buttons, guidance panel, trip estimates
                                        │    ├─ CPListTemplate: destinations (saved, recent); routes (the alternatives)
                                        │    ├─ CPSearchTemplate
                                        │    └─ CPAlertTemplate: a notice (location, a route held without an adapter)
                                        ├─ CPNavigationSession: the trip, for CarPlay's own panel, cluster and banners
                                        └─ CPWindow.rootViewController ◀─ React root "CarPlayMap" on the app's one host
                                                                              │
src/components/car-play/car-play-root.tsx ◀───────────────────────────────────┘

src/components/car-screen/car-session.ts  route, places, words, voice, notice, search ─▶ CarPlayModule ─▶ CarPlaySession
  (the same session as Android Auto's)    ◀─ onCarAction (the same actions)
```

**One session, two cars.** The JS side of a connection is `runCarSession` (src/components/car-screen/car-session.ts,
Jest), the one Android Auto runs: it keeps the navigator running (`Runtime.setCarScreen`), connects the adapter,
sends the route (`carRoute`), places, words, voice and notices, and acts on what the driver does. CarPlay's module
implements its `native` interface (the same payloads and `CarAction`s as `AndroidAutoModule`, with the shared types
moved out of the Android module), so the TypeScript that decides what the car shows is shared, and each platform's
native side only draws it with its templates. What differs by platform comes in through `CarSessionDeps`: the trip
log's name (`carplay connected`, `carplay: …`, Sentry tag `feature: carplay`), and what has no CarPlay counterpart
(the test drive). On iOS the session starts on the module's connect event (a listener registered in index.ts, the app's
one JS runtime) and ends on `session-ended`, apart from the map's root: the map is a view, the session is the
connection.

### Built

- **The map is React Native**: the root `CarPlayMap` (registered in index.ts) renders the phone's `MapSurface`, so the
  style, dot, route and camera are the phone's, and over-the-air JS updates reach the car's screen. The view comes
  from `ExpoReactNativeFactory.recreateRootView` (ExpoModulesCore's protocol; the factory is the template AppDelegate's
  `reactNativeFactory`, reached by reflection since a module can't depend on the Expo pod). It starts the host when
  the phone's scene hasn't: the app opened from the car with the phone locked. It is made without the app delegate
  subscribers' root view customizations: expo-splash-screen keeps one splash and moves it to the newest root view,
  which covered the car's map with the launch screen for good and would leave the phone's on screen if CarPlay
  connected while it showed.
- The root is mounted while a car is connected and unmounted when it goes. CarPlay connects the scene in the
  background as soon as the car's screen comes on, and makes it active when the driver opens the app there:
  "connected" doesn't mean shown. Device log (`ai.wtf.navigator`, category `carplay`): the scene connected, active,
  in the background, disconnected, and what drew the map.
- **Guidance** on `CPNavigationSession`: a trip per destination (a re-plan to the same one is the same trip), the next
  maneuver and the one after when close (the phone banner's words, SF Symbols for icons), the estimates to the next
  maneuver and to the destination with every snapshot, finished at arrival, cancelled when the route stops or the
  scene ends. Today from `src/components/car-play/car-guidance.ts`, which the shared session's `carRoute` replaces.
- **Voice** plays through expo-audio wherever iOS routes it, CarPlay's audio included (`carplay` in the trip log's
  audio output, ROUTING-SPEC §8.5).

### To build: Android Auto's features on CarPlay

| Android Auto (ANDROID-AUTO-SPEC) | CarPlay |
| --- | --- |
| Session as a headless task, the navigator kept running, the adapter connected (§3) | The shared session on the module's connect event (above). Location: the app's background location mode covers GNSS while CarPlay shows another app; no service of its own. |
| Turn and trip cards from `carRoute` (§4 Templates) | `CPNavigationSession.upcomingManeuvers` and `updateEstimates`, `CPMapTemplate.updateEstimates(_:for:)`; planning: `pauseTrip(for: .loading)`, planning again after leaving the route: `.rerouting`; arrived: `finishTrip`; failed: a `CPNavigationAlert` with the phone's words, then the trip cancelled. Steps keep `carManeuverId`, so a re-plan doesn't renew a maneuver CarPlay already shows. |
| Stop guidance, Search, Destinations, voice buttons | `CPMapTemplate` navigation bar buttons: Destinations and Search with no route, Stop guidance and Routes while one is followed; the voice button among them, gone at volume 0. |
| Destinations: saved, then recent (§4) | `CPListTemplate` pushed over the map, sections Saved and Recent, as many as `CPListTemplate.maximumItemCount` allows; one picked: `go`, the map popped back. |
| Search: the phone's offline index, answers for the text in the field (§4) | `CPSearchTemplate`: `updatedSearchText` sends `search`, its completion takes the answers when they come for that text; `selectedResult` sends `go`. CarPlay limits the keyboard while driving. |
| Alternative routes: drawn on the map, the routes list, a tap on a line (§4) | Drawn by the shared map. The routes list as a `CPListTemplate` (the same titles by street, `choose-alternative`). A tap on the map has no CarPlay event on a template app: the list only. |
| Moving the map: drag, fling, pinch, +/−, recentre (§4) | `CPMapTemplateDelegate` pan callbacks (`didUpdatePanGestureWithTranslation`, `didEndPanGestureWithVelocity`, and `panWith` direction from a knob in the panning interface) sent as the same `CarMapGesture`s; + and −, recentre and pan as `CPMapButton`s (four at most). |
| Notices: no location permission, a route held without an adapter (§3) | A `CPAlertTemplate` with the notice's title and words and its button(s): Allow (the request shows on the phone; CarPlay can't show the system dialog) or I'll follow the route and close. |
| Turn pop-ups while another app fills the screen (NF-3) | CarPlay's maneuver banners, allowed by `CPMapTemplateDelegate.shouldShowNotificationFor` / `shouldUpdateNotificationFor` by Android Auto's rule (`CarGuidanceLogic.turnNotification`: within 300 m or 20 s, once per maneuver, never on the driver's own way), ported to Swift logic in `modules/car-play/ios/Logic/` (`swift test`). |
| Voice as navigation guidance, mixed over the car's audio (§3) | The audio session in the `.voicePrompt` mode with `.interruptSpokenAudioAndMixWithOthers` and `.duckOthers` while a car is connected, as Apple asks of navigation apps; the system voice in the same session. |
| One voice whatever the screens (`VoiceGuide`) | The same: the session claims it; the phone's map while mounted. |
| Places asked for (NF-6: the assistant, another app) | `geo:` and `maps:` links and Siri: how iOS hands a place to a third-party navigator while CarPlay shows it is open (§7). |
| The car's day and night, the visible area as insets (§4) | The root's `dark` from `CPInterfaceController.carTraitCollection`, its insets from the window's safe area and the map buttons' layout guide; the same `CarMapProps`. |
| Bigger map: `MAP_SCALE`, POIs and ways of `carMapStyle` (§4) | `carMapStyle` as is; the scale measured on the simulator's car screens (§5). |
| The map data credit, fading after 5 s | The same, drawn by the root (no density mismatch on iOS). |
| The cluster gets the trip (NF-4) | `CPNavigationSession`'s maneuvers reach a car's cluster and CarPlay Dashboard by themselves; a cluster or dashboard map of the app's own (`CPSupportsInstrumentClusterNavigationScene`, `CPSupportsDashboardNavigationScene`, Info.plist) is later (§7). |
| Another navigator starts: the route ends (NF-5) | `CPMapTemplateDelegate.mapTemplateDidCancelNavigation`: `end-route`, so the voice and the banners are the other navigator's alone. |
| The test drive (NF-7) | Apple's review asks none. On the simulator `xcrun simctl location … start` drives along waypoints; the shared `TestDrive` can be started from a debug button if the simulator's GNSS isn't enough. |
| Maneuver icons: the app's own Material Symbols (`scripts/car-icons.py`) | The same glyphs as template images for `CPManeuver.symbolImage`, light and dark, in place of the SF Symbols. |

Must not drift:

- The car's map shows the navigator's position. No MapKit map, no CoreLocation user location: both show the jammed
  or spoofed GPS.
- Offline like the phone: the map packs, no network.
- Native stays thin (SPEC §6): templates and sessions in Swift, what they show decided in TypeScript, shared with
  Android Auto.

## 5. Development: a Mac with the Simulator

No Mac of our own and no car: development runs on a rented Mac (Apple Silicon, macOS 26, Xcode 26.6 as the store
build's runner). The GitHub runner builds what ships, not what is iterated on.

1. Runtimes: one below iOS 26.4 for daily work, the newest now and then. From 26.4 CarPlay's own process crashes when
   an app opens on the map template (`CarPlayTemplateUIHost`: `-[CPSTemplateInstance
   vehicleSupportsDestinationSharing]: unrecognized selector`, the template's destination-sharing button) and goes back
   home.
2. A Debug build (`npx expo run:ios`) with `CARPLAY_ENTITLEMENT=1` and Metro on the same Mac: TypeScript changes reload
   in seconds, Swift rebuilds incrementally. Signed to run locally only, so the entitlement is embedded; no account.
3. CarPlay's display: Simulator → I/O → External Displays → CarPlay. With `defaults write com.apple.iphonesimulator
   CarPlayExtraOptions -bool YES` its size can be chosen (a narrow 800×480 and a wide 1920×720 as for Android Auto's
   heads). `xcrun simctl io <udid> screenshot --display=external` takes the car's screen. CarPlay lists the app by the
   entitlement alone; the scene connects as soon as the display comes on.
4. `xcrun simctl location <udid> set|start` gives the phone's GNSS (phone-only mode trusts it, UI-SPEC §6.3).
5. The device log: `xcrun simctl spawn <udid> log stream --predicate 'subsystem == "ai.wtf.navigator"'`.

Settled on the simulator: the app listed and opened on the CarPlay home screen; the map drawn by the React root; the
scene connected in the background when the display comes on and active when the app is opened there.

## 6. Not chosen

- **react-native-carplay** (and forks): JS-driven templates, but no Expo config plugin and manual scene setup in the
  AppDelegate, which CNG regenerates; and the templates' state would live in JS instead of the shared session.
- **@bradford-tech/expo-carplay**: an Expo plugin, but its map is a native `MKMapView` with CoreLocation tracking:
  Apple's online tiles and the phone's GPS (§4, must not drift).
- **A native MapLibre view** in Swift fed positions from JS: a second copy of the style, dot and route drawing, and no
  over-the-air updates for it.
- **A CarPlay session of its own in TypeScript**: two copies of what the car shows, drifting apart; the session is
  Android Auto's (§4).
- **Trip previews** (`showTripPreviews`) before driving: Android Auto starts a route at once and offers the
  alternatives while following; CarPlay does the same.

## 7. Open items

1. The scene life cycle's breakages (§3), before `main`.
2. The features of §4 "To build".
3. **AppState with only the car's screen in front** (phone locked): React Native's AppState follows the application
   state; GNSS on the phone's screen and the trip recorder key off `active` and `background`.
4. Whether the CarPlay scene connects with `UIApplicationSupportsMultipleScenes` false (set true after Apple's sample).
5. Places asked for: what Siri and other apps give a third-party navigator on CarPlay (URLs to the scene, App
   Intents), read as Android Auto's request (SEARCH-SPEC §4.6).
6. Two MapLibre views on one JS thread with the particle filter's budget (SPEC §8.6).
7. Debug builds: the car's root under the development launcher and Metro.
8. Later: the dashboard and instrument cluster scenes; iOS 27's panels on the map template and route sharing with the
   car.
9. A real car, from TestFlight: the map in motion, the voice over the car's audio, the banners, the cluster.
