# wtf.ai — CarPlay: Specification

The map with the navigator's position, the route's guidance and a destination to pick, on the car's CarPlay screen.
Companion to [ANDROID-AUTO-SPEC.md](ANDROID-AUTO-SPEC.md): CarPlay is the same car screen on iOS, run by the same car
session in TypeScript; only the templates that draw it are CarPlay's. **Status:** in testers' cars from TestFlight: a
route followed on the car's screen with its card, estimates and speed. Android Auto's features run (§4), what CarPlay
can't do is listed there. §7 lists what is open.

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

- The plugin also adds the map links' URL types (`geo`, `google.navigation`): iOS opens the app for them as Android does
  (SEARCH-SPEC §4.6, §5), the phone's route screen, or the car session's request (§4) when they come to the car's scene.

What the scene life cycle changes:

1. **Launch options and the launch state.** A scene app gets no launch options (on the simulator a relaunch for a
   significant location change came with none: no `.location`), and every launch starts in the background state, the
   user's too. Both broke the drive wake (VEHICLE-LINK-SPEC §11) and the adapter's restoration: `AppHealth` now takes a
   scene in front within 5 s as the user's launch, and the update `DriveWake` gets within 30 s of a launch with none in
   front as its reason (`location`), index.ts looking again 3 s after launch; `VehicleLinkAppDelegate` creates the
   central with its restore id at every launch with Bluetooth allowed, as Apple advises for scene apps. Seen on the
   simulator: a user launch is not a wake; a relaunch for a significant change is, and the drive wake runs.
2. **React Native starts with a scene** (Expo's scene delegate starts it as the phone's connects). A relaunch in the
   background connects the phone's scene in the background too (seen on the simulator: JS ran for the drive wake).
   Without the phone's: the car's screen starts it (§4), and `AppReactHostAppDelegate` (modules/car-play) starts it when
   no scene has connected 3 s after a launch in the background (at once when launch options say location or
   Bluetooth). Device log: `background launch …, no scene`.
3. Links (`wtfai://`, `geo:`) are forwarded by Expo's scene delegate: the development client's links and a `geo:` link
   open the phone's screens on the simulator.

## 4. The car's screen

```
CarPlay ─▶ WTFCarPlaySceneDelegate ─▶ CarPlaySession (Swift, main thread; logic: ios/Logic/CarPlayLogic.swift)
                                        ├─ CPMapTemplate (root): bar buttons, map buttons, guidance card, trip estimates
                                        │    ├─ CPListTemplate: destinations (saved, recent); routes; a request's answers
                                        │    ├─ CPSearchTemplate
                                        │    └─ CPNavigationAlert: a speed camera ahead; a notice (location, a route held without an adapter); a failed plan
                                        ├─ CPNavigationSession: the trip, for the guidance card, banners and the car's cluster
                                        └─ CPWindow ◀─ CarPlayMapController ◀─ React root "CarPlayMap" on the app's one host
                                                                                   │
src/components/car-screen/car-map-root.tsx (Android Auto's CarMap too) ◀───────────┘   and its speed (car-speed-pill.tsx)

src/components/car-screen/car-session.ts  route, places, words, voice, notice, search, speed ─▶ CarPlayModule ─▶ CarPlaySession
  (the same session as Android Auto's)    ◀─ onCarAction, onMapGesture (the same actions and gestures)
```

**One session, two cars.** The JS side of a connection is `runCarSession` (src/components/car-screen/car-session.ts,
Jest), the one Android Auto runs: it keeps the navigator running (`Runtime.setCarScreen`), connects the adapter,
sends the route (`carRoute`), places, words, voice and notices, and acts on what the driver does. Its payloads and
actions are `car-types.ts`, which both modules' bindings declare. CarPlay's differs by its name in the trip log
(`carplay connected`, `carplay: …`), the Sentry tags (`feature: carplay` on its reported problems, `car_screen: carplay`
on every event and native crash while the session runs, `none` after), and no test drive. `listenForCarPlay`
(car-session-task.ts, from index.ts) starts it on the module's `onConnect`, or at once in a JS runtime that comes up
with the session open (a launch from the car, a reload); it ends on `session-ended`. The session opens when the driver
first opens the app on the car's screen and lasts until the car disconnects, as Android Auto's: CarPlay connects the
scene as soon as its screen comes on, whatever the driver opens there, and an app never opened on that drive keeps
GNSS and the adapter as they were. What the JS side sent is kept on the native side across runtimes and connections
(CarLink's role on Android): the route followed shows at once when the car's screen comes back.

### Built

- **The map is React Native**: the root `CarPlayMap` is `CarMapRoot` (car-map-root.tsx), Android Auto's car map with
  CarPlay's module for its gestures and buttons, rendering the phone's `MapSurface`: style, dot, route and camera are
  the phone's, and over-the-air JS updates reach the car's screen. Heading-up, smoothed every frame, the dot 0.85 down
  the visible map. The root's props: `dark` from the scene's `contentStyle` (the car's day and night, followed on
  `contentStyleDidChange`), `insets` from the window's safe area (CarPlay's guidance card and bar) and, on the right,
  the map buttons' layout guide: the camera keeps the dot in the rest; `scale`; `cameraSign`, the camera's alert up with
  its sign (the speed's pill then shows none). Sent again only when they change; they follow the bar and the buttons
  showing and hiding. The view comes from `ExpoReactNativeFactory.recreateRootView` (ExpoModulesCore's
  protocol; the factory is the template AppDelegate's `reactNativeFactory`, reached by reflection since a module can't
  depend on the Expo pod), in `AppReactHost.swift`, without the app delegate subscribers' root view customizations:
  expo-splash-screen keeps one splash and moves it to the newest root view.
- **At the car's own points** (`CarPlayLogic.mapScale` 1): CarPlay's points are made for the car's screen (its own
  text is in them), unlike Android Auto's dp, which its map draws 1.4 times bigger; at 1.4 the car's map looked
  zoomed in, little of it on a 400×240 pt screen. The car's style (no footways, only a driver's POIs) at the style's
  own sizes (`carGuidelineSizes` false; Android for Cars' 24 dp and 36 dp are Android Auto's). `CarPlayMapController`
  can still draw the root bigger (laid out smaller, scaled up; gestures and insets divided by it). The follow zoom is
  moved out by the screen's scale (`zoom`, `CarPlayLogic.followZoomShift`: one level at 2×): as much road per pixel as
  Android Auto shows, whose map keeps the phone's zoom per dp, about one of the car's pixels. At the phone's zoom a
  400×240 pt screen showed 150 m across, the road ahead within a block.
- **The map's root lives only while the car's screen shows the app**: made when the scene comes to the foreground,
  released when another app fills the screen (the guidance, banners and voice go on). Mounted in the background, its
  smoothing loop would spin the JS thread with the app in the background (the CPU kill of `use-smoothed-position.ts`)
  and MapLibre would draw for nobody. Android Auto's surface comes and goes the same way.
- **The map waits for React Native.** The root is made only on a running host (the factory's `reactHost`); until
  then the car's screen is blank. A root view made with no host starts one past Expo's React delegate handlers, and
  expo-updates is then asked for the bundle before it is set up (an assertion in Debug, a force-unwrap in Release).
  `CarPlayModule`'s `OnCreate` runs with each JS runtime; on a host other than the one the root was made on, the root
  is made again (the development launcher makes a new host at each load; a root left on the old one is a black
  screen). A reload on the same host (Metro, the dev menu, an update's relaunch) restarts the root by itself, and
  making it again then too crashes ("Surface must not be running").
- **The car starts React Native when the phone's scene doesn't** (the app opened from the car, the phone locked): one
  turn of the main loop after the car's screen shows the app, if no phone scene is connected, `startWithoutPhone` goes
  through the handlers as the phone's scene does (expo-updates chooses the bundle, the development launcher loads the
  last one), asking for the root `NoScreen` (index.ts), which renders nothing. The handlers put the root in place of
  the view they returned, found through its view controller and the app's window, so that view is held by a child
  controller in a window of its own (never shown: it has no window scene), which stands in as the app delegate's
  window until the phone's scene sets its own: without a window expo-updates stops the app. When both scenes connect
  at one launch, both start; expo-updates still starts once (the second call finds its controller started); in Debug
  the development launcher loads twice.
- **Templates**, built from the last state the session sent (which buttons: `CarPlayLogic.barButtons`, `mapButtons`;
  the trip: `tripPlan`; `swift test`):

  | State | The map template shows |
  | --- | --- |
  | A speed camera ahead (before any notice or failure, which come back after it) | An alert over the map: the camera's words and sign, counting down; CarPlay's x |
  | A notice: no offline map installed | An alert over the map: No offline map, routes and search need a downloaded region; button: Close (CarPlay draws it as its x) |
  | A notice: no location permission | An alert over the map with its words; button: Allow |
  | A notice: a route held without an adapter | An alert; buttons: I'll follow the route, Cancel |
  | No route | The map; bar: Destinations, Search; voice. Buttons: pan, recentre, +, − |
  | Planning, or planning again after leaving the route | The card waiting (`pauseTrip` `.loading`, `.rerouting`); buttons: the X, voice, pan |
  | Followed | The next maneuver (the phone banner's words and icon, the distance rounded as the banner rounds it), the one after when it follows closely; the trip estimates (arrival, time and distance left); buttons: the X, voice, the routes while there are others, pan |
  | Arrived | The card says so (`pauseTrip` `.arrived`); the trip finishes when the route goes |
  | Failed | The trip cancelled, an alert with the phone's words; Close |

  While the bar shows (a touch on the map, and for about 20 s after a list closes) CarPlay sets the guidance card
  below its whole row, buttons in it or not. So on a route the bar stays empty and the map's buttons, on the right,
  hold what it held: Stop guidance as an X (Android Auto's words would not fit), the voice, the routes while there are
  others, then pan, or recentre in its place while the map is free or its follow zoom moved (`CarPlayLogic.mapButtons`;
  four at most). They stay while the bar hides (`hidesButtonsWithNavigationBar` false, `buttonsStay`): pressed, they
  don't bring the bar, and the card stays at the top. + and − are the panning interface's then; a pinch zooms on a
  touch screen. Without a route the bar holds Destinations, Search and the voice, and the map's buttons (pan, recentre,
  + and −) hide with it. The guidance card is CarPlay's: the icon beside the words (`displayStyleFor`
  `.leadingSymbol`), 18 pt, two rows. Its colour is the dark grey of the trip estimates under it (#3B3B3B,
  `CarPlayImages.cardColor`) by day and night, as the template's `guidanceBackgroundColor` and each maneuver's
  `cardBackgroundColor`; the maneuver's icon white in a black edge on it, as every icon (Icons, below), not CarPlay's
  tint, which follows the car's day and drew it black. iOS 26.4 draws the card red when the app gives no colour, and a
  colour given after the template shows stays red (developer forums 822242): it is set as the template is made.

  Destinations: saved places, then recent ones, as many as `CPListTemplate.maximumItemCount`; one picked routes to it
  (`go`), the map popped back. Search (`CPSearchTemplate`): each change of the field goes to the session (`search`),
  whose answers complete it once they answer the text in it (`CarPlayLogic.searchList`); nothing typed lists the
  destinations; nothing found is one row saying so. Above the keyboard there is room for one answer or two, and nothing
  puts the keyboard away: its search key opens the answers in a list over the search
  (`searchTemplateSearchButtonPressed`). While the car allows no keyboard (`CPSessionConfiguration`'s
  `limitedUserInterfaces`, many cars while driving) the search button goes: the destinations are the way then, and
  CarPlay shortens the lists itself. A place asked for
  with several answers opens them in a list (`openSearch`): CarPlay's search can't be given a text. The routes list:
  the route followed, then each alternative, titled by the street it goes by, then how it compares, its time and
  distance (`choose-alternative`). The car's words are the app's (en/uk), sent by the session; English until it has.
- **The navigation session** (`CPNavigationSession`): a trip per destination (a re-plan or an alternative to the same
  one is the same trip; setting off again after arriving is a new one), started when a route is planned. Maneuvers
  are set again only when other ones are next, or when the next comes near enough for a banner; the estimates only
  when what CarPlay shows of them changes (the rounded distance, whole minutes: `CarPlayLogic.estimatesKey`), as
  Apple's guide asks. With them, metadata for the car's own cluster and head-up display
  (`mapTemplateShouldProvideNavigationMetadata`): the maneuver type, roundabout junctions, right-hand traffic, and the
  maneuver's state (prepare within 300 m or 20 s, execute within 50 m or 5 s; `CarPlayLogic.maneuverState`). CarPlay
  Dashboard and the instrument cluster show the maneuvers by themselves. The car's "cancel navigation" (its own
  navigator started) ends the route (`mapTemplateDidCancelNavigation`: `end-route`), so the voice and the banners are
  the other navigator's alone.
- **Turn banners** while another app fills the car's screen: CarPlay asks about a banner for each maneuver it is
  given; the next maneuver pops up once within 300 m or 20 s at the plan's pace, not the departure, nothing on the
  driver's own way (`CarPlayLogic.turnAlert`, Android Auto's rule). Its distance follows while it shows. Trip log:
  `carplay: turn notification popped up: <words>`.
- **Notices** as alerts over the map (`CPNavigationAlert`, until dismissed), one at a time, a notice before a failed
  plan. Their words state the condition and never send the driver to the phone (`carNotice`'s `phoneFree`, Jest:
  "Without location access the car's position can't be shown.", "The car's position isn't set yet."), as Apple's
  guidelines require; Android Auto's say where to look. No offline map first: without one the map is a plain canvas
  and search finds cities only, and a driver who opened the car's screen first saw nothing say why. It only closes
  (`CarPlayLogic.noticeButtons`), by its button or CarPlay's x, and goes when a region is installed (the session
  follows the map packs); Android Auto shows it too (ANDROID-AUTO-SPEC §3). Location: while iOS has never asked, Allow asks
  (`requestWhenInUseAuthorization`; the dialog is the system's), and the alert comes back until the answer; refused
  before, nothing on the car's screen can allow it: the alert has Close, and stays closed until the notice changes. A
  change of the permission redraws it; the session checks it every 5 s and takes the answer (`permission`). A route
  held without an adapter: its button gives the driver's word (`confirm-held`), Cancel drops it (`cancel-held`). A
  failed plan's alert names the destination and says why in its subtitle, naming no phone screen (`carRoute`'s
  `phoneFree`: no map is "This region's map isn't downloaded.", not the phone's "… in Offline maps"). An alert CarPlay
  takes down comes back; a failure the driver closed (its button or CarPlay's own x, `userDismissed`) doesn't, nor a
  notice that only says something (`closedByCarPlaysX`); one that asks (Allow, a held route) does. Every template operation has a completion:
  CarPlay raises an exception for a failed one without (a pop with nothing to pop ended the app), and the failure goes
  to the trip log instead.
- **Moving the map**: a finger on a touch screen (`didUpdatePanGestureWithTranslation`, `didEndPanGestureWithVelocity`)
  and, from iOS 26, a pinch (`didUpdateZoomGestureWithCenter`) come to the JS map as Android Auto's scroll, fling and
  scale (`CarPlayLogic.scroll`, `zoomFactor`); the panning interface's arrows (cars with a knob or a touchpad) as a
  scroll of 120 pt. While panning the bar has only the X that ends it, on its right; the map's buttons are + and −:
  CarPlay shows only as many as fit beside the arrows (the last two on a 400×240 pt screen), and keeps the arrows below
  the bar's row, empty or not. The camera rules are Android Auto's (`CarMap`).
- **Alternative routes** are drawn and framed by the shared map; the framing keeps at least 40 % of the map's width
  and height for the routes (`fittedPadding`, Jest): CarPlay's card and buttons cover most of a small screen, and
  MapLibre refuses padding larger than the map. The camera goes flat and north up before the fit (UI-SPEC §6.2). A
  route picked with no progress on it yet (an alternative taken while the car stands) shows from its start, as the
  phone's banner does (`carRoute`).
- **No map data credit** on the car's screen: the phone's map shows it as it opens and Settings › About keeps it
  (UI-SPEC §6.1). OSMF's attribution guidelines allow a credit at an application's start that isn't shown each time it
  is looked at, if the licence stays easy to find; they say nothing of a second screen. Apple's guide keeps the base view
  to the map.
- **The speed and speed cameras** (UI-SPEC §6.4, §6.5): the session follows the app's one speed and camera warning
  (`SpeedAlerts`) while it runs, as Android Auto's, so the chime and "Speed camera ahead" sound with no phone screen
  too, once whatever screens show them; it sends the car what it shows (`carSpeed`, `setSpeed`, Android Auto's
  payload).
  - **The speed:** Android Auto's pill, drawn by the map's root (`CarSpeedPill`): the limit's sign and the speed with
    its unit, red past the driver's margin; no speed, none. While the bar hides, in the top right corner above the
    map's buttons, which CarPlay stacks from the bottom (on a 240 pt high screen the fourth one's top is 68 pt down);
    the safe area ends at the buttons' 40 pt column whether they show or not, so the pill's room on the right is the
    safe area's less that column (`CarPlayLogic.speedRight`, the root's `speedRight`; a right-hand drive car's dock
    stays out). Not Android Auto's bottom left there: on a route the visible map is the narrow band between the
    guidance column and the buttons, and at its bottom left the pill covered the car's dot (0.85 down, in the band's
    middle). While the bar shows (a top inset; a touch, and about 20 s after a list), the card and the corner come
    down level with the X: the pill goes to the visible map's bottom left. A build without
    `speedRight` puts it beside the buttons' column. In the car's
    day or night, at its points (the sign 30 pt), not grown by the phone's text size; nothing on it to press, inside
    the safe area. A review risk (§7): the guide allows nothing but the map in the base view, overlays included, even
    information as passive as lane guidance, and no template shows a speed (iOS 26). The pill rests on one Apple
    developer support engineer's reading that a current speed and a speed limit sign, not pressable and inside the
    safe area, are allowed (developer forums 852888), which is not policy.
  - **The camera ahead:** CarPlay's navigation alert, Apple's panel for real-time feedback, where CarPlay puts it: the
    visible map's bottom left, on a route in the guidance card's column in place of the trip estimates; the safe area
    shrinks for it. The phone card's words ("Speed camera in 600 m"; past the margin "Slow
    down", the distance under it), the camera's sign as its image (`CarPlayImages.speedSign`; the camera's glyph when no
    limit is known, drawn as big: CarPlay fits both to one slot), CarPlay's x. The words are updated in place as the
    distance counts down (`updateTitleVariants`), the same alert while the camera, its sign and its red are
    (`CarPlayLogic.cameraAlert`, `swift test`); "Slow down" is an alert of its own, sliding in as the warning starts: a
    subtitle given to an alert made without one never showed (iOS 26.3). It goes at the camera. No bar and no red:
    CarPlay draws the panel, and "Slow down" says it. Closed by the driver, that alert isn't shown again while the car
    is connected (`camera alert closed by the driver #…`), but a "Slow down" after it is: the voice speaks once, as the
    camera is first in sight, and nothing else would warn. While another app fills the car's screen each new alert pops
    up once as a notification (`camera notification popped up #…`), for about 9 s, its words as they were then (CarPlay
    doesn't update a notification), also after the camera is gone; the alert itself stays up, so it doesn't pop up
    again. While the alert shows the camera's sign the pill shows none of its own, one sign on the screen
    (`speedBesideCard`); CarPlaySession tells the map's root so (its `cameraSign` prop), and with the alert closed the
    road's sign is back.
  - **On the map:** the cameras' badges, as on the phone's.
- **Voice** as navigation guidance while the session is open (ROUTING-SPEC §8.5): expo-audio's session in the
  voice-prompt mode, spoken audio interrupted and others ducked, which CarPlay mixes over the car's audio, active only
  while a clip plays (expo-audio lets it go after). Before each prompt the session's `promptStyle`: none (a call, Siri)
  or short (the app has no tone) says nothing (`voice: not said, CarPlay asks for …`). One voice whatever the screens
  (`VoiceGuide`).
- **JS timers while only the car shows the app** (`ReactTimerPace`, `TimerPaceLogic`): React Native's `RCTTiming`
  fires setTimeout, setInterval and requestAnimationFrame from a CADisplayLink of the phone's screen unless the app is
  in the background (NSTimers then), and the car's screen keeps it out of the background. With the phone's screen dark
  that display link stops, and with it every JS timer: the navigator's tick, the dot on the car's map (MapLibre, on
  the car screen's own display link, goes on drawing a still map). So the timers keep React Native's background mode
  unless a phone scene is in the foreground: its `appDidMoveToForeground` and its setup (a runtime started for the car's
  screen alone) are replaced at launch, and a phone scene activating or going to the background moves each timing
  between the two. React Native is prebuilt, so its source can't be patched. Nothing paces requestAnimationFrame
  there (a setTimeout(0)): a loop on it spins the JS thread, so the dot's smoothing waits a frame on a timer
  (UI-SPEC §6.2). Device log: `JS timers on their own, the phone's screen not showing the app` / `on the phone's display`.
- **The phone's theme** stays the app's (Settings › Appearance) whatever the car's day and night
  (`ReactSceneGuards`): React Native keeps one colour scheme for the app and takes it from any React root whose traits
  change, and the car map's root has the car's. A car by day turned the phone's dark theme light, until the setting
  was switched off and on. The car's roots are left out; the car's map takes its day and night from its `dark` prop.
  The theme setting reaches the phone's windows only, not the car's (CarPlay's scene has none for React Native's loop).
- **The app's state while the car shows it**: iOS calls the app `active` while the car's screen shows it, the phone
  locked, dark or elsewhere (the trip log's `app_stats`; JS timers stopped with the phone's screen dark in that state
  before `ReactTimerPace`); `background` while another app fills the car's screen and the phone doesn't show the app;
  `inactive` only in passing.
- **Location while the car shows the app**: the background location session (TRIP-LOGGER-SPEC §4.3) counts the car's
  session as the app in front (an `inactive` moment too) and as busy, so it is held from a session opened on the car
  alone and GNSS goes on while another app fills the car's screen. The update check and the map packs' refresh key off
  `active`, which the car's screen gives too: they run on a drive with only the car's screen showing the app.
- **Places asked for**: a `geo:` (look for it) or `google.navigation:` (go there) link that comes to the car's scene is
  the session's request (SEARCH-SPEC §4.6), as Android Auto's navigation intents. Links opened on the phone go to the
  phone's route screen; Apple Maps links open Apple Maps, and are read when pasted into the search.
- **Icons**: the app's Material Symbols, drawn by `scripts/car-icons.py` as SVG images into
  `modules/car-play/ios/CarIcons.xcassets` (the pod's `WtfCarPlay.bundle`), with Android Auto's drawables. Every one
  is drawn white in a black edge (1.25 pt, `CarPlayImages.IconStyle.outlined`) into its pixels, by day and night,
  focused or not: the bar's buttons, the map's, list rows, maneuvers and the alerts' images. Never CarPlay's tint,
  which follows the car's day and not what is under the icon: by day it drew the list rows' icons black on the black
  of a focused row and a maneuver's black on the dark guidance card, and on iOS 26 its tint of map buttons is wrong
  (Apple's known issue; developer forums 798735, 799192, 842273), white on its white focus fill, and reported white on
  near-white buttons by day. A tint given with `withTintColor` is lost too: CarPlay draws the image in its own
  process, and the vector's black ink showed. Under the icons: a list, light by day with a black focused row; the
  map buttons' glass, which takes its shade from the map behind each button, near white over a light map and dark
  over water side by side (the day preview, §5), a mid grey in a car by day, its focus fill white; the dark card.
  One colour alone vanished on one of them: the app's dark text colour on the grey, white with a faint edge on the
  near white; a focused black icon read as another kind of button. Grey looked disabled, and the app's blue reads as
  a mode turned on. Drawn at their size from the vector: bar buttons 24 pt, list rows 32 pt, maneuvers 18 pt, an
  alert's 24 pt (a camera's glyph 40 pt). A map button's drawing is scaled to the X's, 14 of its 24 pt
  (`CarPlayImages.mapIcon`, the ink measured once): the symbols leave different room around their drawing, and the
  voice and my location filled the round button.
- Device log (`ai.wtf.navigator`, category `carplay`): the scene connected, in the foreground, active, in the
  background, disconnected; React Native started without the phone's scene or on a new host; what drew the map;
  actions sent (info level); the notes also go to the trip log.

What CarPlay doesn't do of Android Auto's: the test drive (NF-7; Apple asks none: `xcrun simctl location start` drives
on the simulator, §5); a tap on a grey route (the map template has no tap event: the routes list); the search screen
opened with a place's words (a list of its answers instead); the camera card's bar and red (CarPlay's alert instead).

**Apple's guidelines** (CarPlay App Programming Guide, navigation apps), and how the app meets them: turn-by-turn with
upcoming maneuvers (the navigation session); the base view only for the map (the React root draws map content: roads,
the dot, the route and its labels; no map data credit), but for the speed's pill, an overlay the guide's letter rules
out (§7); templates for their purpose (the icons
are maneuvers' only); a pan button and the panning interface; touch gestures only to move and zoom the map; guidance
ended at once when the car cancels it; voice prompts in the voice-prompt mode, mixed with the car's audio, the session
active only while one plays, `promptStyle` checked; no wording that asks the driver to use the iPhone, and every flow
possible on the car (location refused before is the one thing only the phone can change, and the alert says only what is
wrong); keyboard limits observed; estimates updated when they change. Dashboard and instrument cluster scenes are
optional (§7).

Must not drift:

- The car's map shows the navigator's position. No MapKit map, no CoreLocation user location: both show the jammed
  or spoofed GPS.
- Offline like the phone: the map packs, no network.
- Native stays thin (SPEC §6): templates and sessions in Swift, what they show decided in TypeScript, shared with
  Android Auto.
- The car never makes a React root without a running host, and starts React Native only through Expo's React
  delegate handlers: expo-updates chooses the bundle the car's screen runs, as it does the phone's.
- The map's root lives only while the car's screen shows the app.
- No words on the car's screen that ask the driver to use the phone.
- The car's day and night never set the phone's theme.
- Every CarPlay template operation passes a completion.
- The guidance card's colour is given as the map template is made, before it shows: iOS 26.4 draws it red otherwise.
- The map stays the biggest thing on the car's screen: no panels of the app's own over it (Apple's guidelines keep the
  base view to the map), the bar as small as it can be. The speed's pill is the only exception, a review risk (§7).

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
6. Reloads: Metro's (its `r` key) is a `{"version":2,"method":"reload"}` message on `ws://localhost:8081/message`,
   the same host; the development launcher's (`xcrun simctl openurl <udid>
   "wtfai://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`) makes a new host. A launch from the car
   alone: the app terminated, then its icon on the CarPlay screen clicked.
7. A prebuild with `UPDATES_ORIGIN` set (`.env.local`) writes the update code-signing certificate into the generated
   `Expo.plist`, and the development client then asks Metro for a signed manifest, which it can't give ("Must specify
   --private-key-path"): for a local Debug build, prebuild without it or take `EXUpdatesCodeSigningCertificate` and
   `EXUpdatesCodeSigningMetadata` out of the generated plist.
8. Driving the car's screen from a script: clicks posted as CGEvents on the CarPlay window (the Mac unlocked; the
   first click on an unfocused window only focuses it). The bar (and without a route the map's buttons) hides while
   idle: a tap on the map shows it, the next one presses. `xcrun simctl location <udid> start --speed=12 <lat,lon> …` drives along
   waypoints (the banners pop up with another app on the car's screen).
9. CarPlay on the simulator can wedge (its screen frozen, then black, "no paired vehicle" in its log; a device reboot
   doesn't help): kill `CarPlay.app`, `CarPlayTemplateUIHost` and `carkitd` in the simulator (`kill -9`; launchd starts
   them again), then turn the external display off and on.
10. Other CarPlay screens (Apple's test sizes: 748×456 and 800×480 @2x, 1920×720 @3x, a portrait one):
    `defaults write com.apple.iphonesimulator CarPlayExtraOptions -bool YES`, the Simulator started again; choosing
    I/O › External Displays › CarPlay then opens a setup window (width, height, scale, touch screen, knob) whose Run
    connects it. CarPlay keeps its old layout inside the new display until its processes are killed as in 9.

Settled on the simulator (iOS 26.3, the 400×240 pt display; the layout also at 1920×720 @3x): the app listed and opened
on the CarPlay home screen; the scene connected in the background when the display comes on, the session opened when the
app comes to the foreground there. In Debug: a launch from the phone; a launch from the car alone (React Native started
without the phone's scene, the map about 5 s after the tap); the phone opened after that; Metro's and the development
launcher's reloads, the map and guidance back each time. In a Release build with expo-updates on: a launch from the car
alone (the map about 1 s after the tap), the phone opened after it, and a launch from the phone. The session: search
typed on CarPlay's keyboard and a result routed to; destinations; a route followed with its card and estimates, the
routes list and an alternative chosen; Stop guidance; the voice muted and back; zoom, recentre, the panning interface;
the location notice with location refused, cleared once it was allowed again; the turn banner over Settings at 290 m on
a simulated drive; the map's root released while another app showed and made again on return; a held route's alert and
its word given; a failed plan's alert closed by CarPlay's x and not back on the next route; arrival on a simulated
drive; a request's answers in a list over the map; the background location session held from a session opened on the car
alone. Not seen there: a link to the car's scene (the simulator gives links to the phone), the night style (its CarPlay
has no night mode), iOS 26's pinch, a car that limits the keyboard. CarPlay's Settings › Appearance offers Automatic or
Always Dark; Automatic follows the car, and the simulated car stays at night whatever the phone's appearance, its
location (midday in Cupertino, the display reconnected) or the Mac's; the Simulator's hidden CarPlay options set only
size and scale. Day mode is previewed by a temporary build that sets the CarPlay window's `overrideUserInterfaceStyle`
to light and the root's `dark` to false: the map, the bar and the map's buttons go light (on iOS 26.3 a template image
was tinted dark there), CarPlay's guidance card stays dark. Each map button's glass takes its shade from the map
behind it there: near white over land, dark over the river beside it. The simulator's CarPlay setup window
(`CarPlayExtraOptions`) keeps scale 3 whatever is chosen: 1200×720 @3x is the 400×240 pt screen. Its Knob draws a knob
under the screen; drags on it posted from a script showed the bar but moved no focus.

States the simulator gives no way into are set from a temporary file required by index.ts in `__DEV__` (`routes.start`
to a place outside the region for a failed plan, `holdRouteForGuide` for a held route, `CarPlay.setSearch` and
`openSearch` for a request, `speedAlerts().getSnapshot` replaced for the speed and a camera ahead: the simulator's
GNSS gave the navigator no trusted road ahead), never committed.

The speed and the camera's alert, so set (states through the session to the alert and the pill): at 748×456 and
800×480 @2x, 768×1024 @2x (portrait, CarPlay's dock under the map) and 1920×720 @3x; with a route; the notifications
over CarPlay's Settings. The cameras' badges and the pill's speed on a simulated drive.

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
- **Route buttons in the bar** (the X, the voice, the routes): pressing one meant a touch on the map to show the bar,
  and with it CarPlay moved the guidance card down a row. They are the map's buttons, shown while the bar hides; + and
  − moved to the panning interface.
- **The X that ends panning among the map's buttons**: CarPlay shows only those that fit beside the panning arrows (+
  and − on a 400×240 pt screen) and hid it, leaving no way out; the arrows stay below the bar's row, empty or not.
- **Guidance drawn by the app over the map** (a card of its own, smaller): Apple's guidelines keep the map template's
  base view to the map; the card, its layout and its padding are CarPlay's.
- **The phone's camera card over the map** (Android Auto's, with its bar and red): a panel of the app's own in the base
  view, which Apple's guide rules out ("Do not draw windows, alerts, panels, overlays, or user interface elements");
  the navigation alert is CarPlay's panel for real-time feedback.

- **Places asked for by Siri** ("Navigate with wtf.ai"): out of scope until Siri speaks Ukrainian. It doesn't, and
  Apple has announced no date. The way would be App Intents (third-party apps get no SiriKit navigation domain): an App
  Shortcut whose phrase holds only the app's name, Siri then asking where to, compiled into the app target (Xcode
  extracts App Intents from the app's own code, not from a pod), the words handed to the car session as a
  `google.navigation:` link.

## 7. Open items

1. Review: §4 meets the guidelines as read, but for the speed's pill over the map, which the guide's letter rules
   out; App Review's verdict on them is unknown. Before the first submission with the pill, ask
   Apple (a developer support request). Dropping it is a change to the car map's JS alone, no native build.
2. Later: the dashboard and instrument cluster scenes of the app's own (`CPSupportsDashboardNavigationScene`,
   `CPSupportsInstrumentClusterNavigationScene`); iOS 26.4's route sharing with the car; iOS 27's panels on the map
   template.
