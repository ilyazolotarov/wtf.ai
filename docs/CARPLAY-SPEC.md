# wtf.ai — CarPlay: Specification (spike)

The map with the navigator's position and the route's guidance on the car's CarPlay screen. **Status: spike** on the
branch `spike/carplay`; nothing here is on `main`. §6 lists what must be settled before it can be.

## 1. Goal

A CarPlay **navigation app**: the car's screen shows the same offline map, dot and route as the phone, the next
maneuvers in CarPlay's guidance panel, and the voice through the car. The dot is the navigator's (SPEC §3), never the
phone's GPS: under jamming the car's screen is no help otherwise.

## 2. What Apple requires

| Need | Fact | Consequence |
| --- | --- | --- |
| Entitlement `com.apple.developer.carplay-maps` | Requested at [CarPlay Contact Us](https://developer.apple.com/contact/carplay) by a **paid Developer Program** account, which agrees to the CarPlay Entitlement Addendum, for an app whose main purpose is turn-by-turn navigation. Reviewed by Apple (days to months); granted as a managed capability of the account. Without it CarPlay doesn't list the app. | Available: an organization account with the owner's go-ahead (§2.1). |
| A signed build carrying it | The CI IPA is unsigned and has no entitlements (`build-ios.yml`); AltStore re-signs it with a free Apple ID, whose profiles can't hold CarPlay. | **No CarPlay in the sideloaded build.** Phones get it from the store path (`build-ios-store.yml`, TestFlight) once the entitlement is granted. |
| Testing without it | The iOS Simulator (I/O → External Displays → CarPlay) takes the entitlement from the entitlements file, no profile: it lists the app on the CarPlay home screen (§6.2). | The simulator job on the macOS runner (§6.2). |

### 2.1 With the organization account

1. The account holder requests the **Navigation** entitlement (link above) and agrees to the addendum.
2. Once granted: Certificates, Identifiers & Profiles → the app's App ID → **Additional Capabilities** → CarPlay
   Navigation on; then a new **App Store** provisioning profile for it (Apple's steps sign it manually).
3. That profile and an Apple Distribution certificate go into the store workflow's manual signing secrets
   (STORE-REVIEW §3.1: `IOS_DIST_P12_BASE64`, `IOS_DIST_P12_PASSWORD`, `IOS_PROFILE_BASE64`, `ASC_APPLE_ID`,
   `ASC_APP_PASSWORD`, variables `APPLE_TEAM_ID`, `ASC_APP_ID`), and the repository variable
   **`CARPLAY_ENTITLEMENT=1`**, which makes the plugin claim the entitlement. Claimed before step 2, it fails the
   signing. Whether cloud-managed signing (the API key) picks up a managed capability is unverified.
4. Actions → Build App Store iOS App on the branch → TestFlight (internal testers: the team's own members).

Open with the account: whether the app lives there under `ai.wtf.navigator` (a bundle id is the team's, and moves to
another account only with an App Store app transfer) or under a bundle id of its own; and whether it is the Developer
Program (TestFlight) or the Enterprise Program (in-house distribution, no TestFlight, another export method).

## 3. Scenes

CarPlay draws in a `CPTemplateApplicationScene`, so the app adopts the UIKit scene life cycle:

- **SDK 57**: `ios.enableSceneSupport` in expo-build-properties (app.json). Prebuild moves the window out of
  `AppDelegate` into Expo's `EXExpoAppSceneDelegate`, which creates it when the phone's scene connects and starts
  React Native into it. **SDK 58** makes this the template's default (the iOS 27 SDK requires it): the costs below
  come with the next SDK upgrade whether or not CarPlay ships.
- `modules/car-play/app.plugin.js` adds the CarPlay scene beside the phone's (`WTFCarPlaySceneDelegate`),
  `UIApplicationSupportsMultipleScenes` (phone and car at once) and, with `CARPLAY_ENTITLEMENT=1` (§2.1), the
  entitlement. It runs after expo-build-properties whatever the order in app.json (that plugin refuses a manifest it
  didn't write). Checked with `npx expo config --type introspect`; prebuild of iOS doesn't run on Windows.

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
                                        ├─ CPMapTemplate (root template): buttons, guidance panel, trip estimates
                                        └─ CPWindow.rootViewController ◀─ React root "CarPlayMap" on the app's one host
                                                                              │
src/components/car-play/car-play-root.tsx ◀───────────────────────────────────┘
  MapSurface (follow-heading, the navigator's position) + carGuidance(route) ─▶ CarPlay module ─▶ CPNavigationSession
```

- **The map is React Native**: the root `CarPlayMap` (registered in index.ts) renders the phone's `MapSurface`, so the
  style, dot, route and camera are the phone's, and over-the-air JS updates reach the car's screen. The view comes
  from `ExpoReactNativeFactory.recreateRootView` (ExpoModulesCore's protocol; the factory is the template AppDelegate's
  `reactNativeFactory`, reached by reflection since a module can't depend on the Expo pod). It starts the host when
  the phone's scene hasn't: the app opened from the car with the phone locked.
- The root is mounted while a car is connected and unmounted when it goes, so the JS side needs no connection events.
  Mounted, it starts GNSS (with permission) and the adapter's auto-connect as the phone's screen does; unmounted, it
  stops GNSS unless the phone's app is in front (a trip keeps it). Trip log: `carplay connected`, `carplay disconnected`.
- **Guidance** (`car-guidance.ts`, pure): from the route service's snapshot,

  | Call | When |
  | --- | --- |
  | `startTrip` (origin, destination, "18 min · 12 km") | A new destination, or a route after arriving. A re-plan to the same destination is the same trip. |
  | `setManeuvers` (the next, and the one after when close) | The plan or the next maneuver changes. |
  | `updateEstimates` (to the next maneuver, to the destination) | Every snapshot. Times at the plan's pace for what is left. |
  | `endTrip` (arrived or cancelled) | Arrival; the route stopped. The scene ending cancels it natively. |

  Instructions are the phone banner's (`maneuverInstruction`); symbols are SF Symbols standing in for the app's icons.
- **Voice** is unchanged: expo-audio plays wherever iOS routes it, CarPlay's audio included (`carplay` in the trip
  log's audio output, ROUTING-SPEC §8.5).

Must not drift:

- The car's map shows the navigator's position. No MapKit map, no CoreLocation user location: both show the jammed
  or spoofed GPS.
- Offline like the phone: the map packs, no network.
- Native stays thin (SPEC §6): templates and sessions in Swift, what they show decided in TypeScript.

## 5. Not chosen

- **react-native-carplay** (and forks): JS-driven templates, but no Expo config plugin and manual scene setup in the
  AppDelegate, which CNG regenerates.
- **@bradford-tech/expo-carplay**: an Expo plugin, but its map is a native `MKMapView` with CoreLocation tracking:
  Apple's online tiles and the phone's GPS (§4, must not drift).
- **A native MapLibre view** in Swift fed positions from JS: a second copy of the style, dot and route drawing, and no
  over-the-air updates for it.

## 6. Open items

1. ~~Compile~~: the branch's CI iOS build passed (2026-10-25).
2. **Simulator job** (`carplay-simulator.yml`): a Release build for the simulator with `CARPLAY_ENTITLEMENT=1`, signed
   to run locally so the entitlement is embedded (checked in the executable), started on the phone; CarPlay's display
   turned on through the Simulator's menu (no `simctl` command does it; GitHub's macOS images let `osascript` drive
   menus and post clicks); the app opened on the CarPlay home screen by a click on its icon, whose label Vision's OCR
   reads in a desktop screenshot inside the CarPlay window (the window frames the car's screen, so the screen's own
   screenshot doesn't map onto it). Passes on the app's own log lines (`ai.wtf.navigator`, category `carplay`): the
   scene active after the click, the map drawn by the React root, and the car's screen off its home screen.
   Settled by the first run: the simulator lists the app with the entitlement from the file alone, and CarPlay
   connects the scene in the background as soon as its display comes on (the map's React root is created then), so
   "connected" doesn't mean shown. On the iOS 26.5 simulator, opening the app there crashes CarPlay's own process
   (`CarPlayTemplateUIHost`: `-[CPSTemplateInstance vehicleSupportsDestinationSharing]: unrecognized selector`,
   from the map template's destination-sharing button, iOS 26.4's) and CarPlay goes back home: the job runs on the
   newest runtime below 26.4. Not covered yet: CarPlay opened before the phone's app, a map pack, a route.
3. Whether the CarPlay scene connects with `UIApplicationSupportsMultipleScenes` false (set true after Apple's sample).
4. **AppState with only the car's screen in front** (phone locked): React Native's AppState follows the application
   state; GNSS on the phone's screen and the trip recorder key off `active` and `background`.
5. Day and night: the car's screen has its own (the CarPlay window's trait collection); the map follows the phone's
   scheme now.
6. Map buttons (recentre, overview, zoom) and panning on the template, sent to the camera.
7. Picking a destination in the car: saved places as a list, the search template (limited while driving), trip
   previews with the alternatives (ROUTING-SPEC §8.7).
8. The app's own turn icons as maneuver images, light and dark.
9. Re-planning shown as such (`pauseTrip(for: .rerouting)`), and the voice ducking other audio as CarPlay expects.
10. Two MapLibre views on one JS thread with the particle filter's budget (SPEC §8.6).
11. Debug builds: a second root under the dev launcher and Metro.
12. Later: the dashboard and instrument cluster scenes.
