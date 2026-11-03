# wtf.ai — Stops on the Way: Specification

Stops between the car and the destination, and places to pull in at along the route (fuel, charging, food,
pharmacies, parking). Builds on routing and guidance ([ROUTING-SPEC.md](ROUTING-SPEC.md)), the search file
([SEARCH-SPEC.md](SEARCH-SPEC.md)) and the route page ([UI-SPEC.md](UI-SPEC.md) §7.1). Source of truth for coding
agents.

## 1. Goal

1. A driver adds a stop while driving in two taps from the Route tab, and sees what it costs before adding it: the
   extra minutes, not the straight-line distance.
2. The driving screen does not change: no new button on the map, no extra row under the banner. Stops live in the
   Route tab.
3. The app never turns the driver back on its own. A stop left behind is offered back, not forced.
4. Offline, like everything else: places come from the region's search file, the detours from the road graph.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Trip | The car, then up to **5 stops** (`MAX_STOPS`), then the destination. Each stretch between two points is a *leg*. |
| Way in | The bottom bar's **Route** tab (the route page). No map button, no strip under the banner. |
| Planning | One `RouteSearch` per leg, joined into one plan (§4). No via-point search inside A\*. |
| Guidance | One `RouteGuidance` over the joined plan; stops are points along it (§5). |
| Time at a stop | None added: arrival times assume no wait; at a stop the times count from now. |
| Stop passed by | Guidance goes on to the next point; a card offers to go back (§5.3). |
| Places along the route | A section of the search file (§6.1), unnamed places included, with fuel types and opening hours. |
| Categories | Fuel, charging, cafe, food (fast food, restaurant), pharmacy, parking. |
| Detour | Two small searches per place near the route, not a full plan per place (§6.3). |
| Car's screen | Shows the trip's stops; adds, removes and reorders none (§9). |

## 3. Status

Built and tested in Jest, the emulator, the Desktop Head Unit and the CarPlay Simulator (§9); not yet driven. Open
items: §12.

## 4. The trip and its plan (`src/nav/routing/trip.ts`, `route-service.ts`)

- **Trip** (`RouteSnapshot.stops`): the stops not reached yet, in order, then `destination`. A stop (`TripStop`) has a
  key of its own for the whole trip, its name and `id`, and its kind and flags (§6.2) when it came from a place.
  Reached and passed stops leave the list. Without stops everything is as ROUTING-SPEC describes.
- **Legs:** the first leg starts from the car as ROUTING-SPEC §5.1 says (heading, turnaround). Each later leg starts
  where the previous one ended, as a parked car would: its heading as it arrived (sure to ±10°), standing, so leaving
  the other way costs the parked turnaround (60 s). Each leg's end is found as a destination is.
- **Search** (`TripSearch`): the legs one after another in the same slices (ROUTING-SPEC §5.4), each with the
  planner's limits, the states counted over all of them. A leg that finds no route fails the trip, naming its leg; a
  first plan's failure names the stop (`failedStop`), the banner says "Couldn't find a route to the stop “<stop>”.", and the route page's ✕
  removes it.
- **Joined plan** (`joinPlans`): the legs' edges and polylines one after the other (a leg's first point dropped when it
  is the last one's end); length and time summed; `stops` (`PlanStop`): each stop's key, its leg's end along the
  plan (`atM`) and on the plan's clock (`atS`), the road point, the stop's own point, and its side (§6.4). A trip
  without stops is the plain route, unchanged.
- **Time along the plan** (`elapsedS`): each leg at its own pace. The time left and a stop's time from the car come
  from it, not from the whole plan's average.
- **Instructions** (`tripManeuvers`): each leg's maneuvers in order; between legs, one `stop` maneuver (with the
  stop's key and side) in place of the leg's `arrive` and the next leg's `depart`; a turnaround at a stop stays. The
  last leg ends with `arrive`.
- **Where a new stop goes:** within 1 km of the route ahead, by its place along it among the stops; otherwise between
  the two consecutive points where it adds the least straight-line distance (`insertionIndex`). The route page moves
  a stop earlier.
- **Alternatives** (ROUTING-SPEC §8.7): one leg's other way each, joined with the rest of the trip, so "+4 min"
  compares the whole trip; after every plan (a stop added included) each leg's, the longest first, and again on the
  way for the leg the car is on, so a trip with stops has them all along.
- **One frame per route:** every search of a route (plans, the way back to a stop, detours) shares the graph
  reader, which projects what it decodes into one local frame. The route keeps one frame and makes a new one only
  when the car is 30 km from it; the searches beside the route's own stop then.
- **Kept** in `route.active`: the destination and the stops not yet reached or passed. An app restarted within 12 h
  plans the rest of the trip from the first position.

## 5. Guidance (`guidance.ts`, `route-service.ts`)

### 5.1 To a stop

`GuidanceStep` gives the next stop (`nextStop`), the distance and time to it, and the stops reached and passed. The
banner's maneuver lines are unchanged; its last line counts to the next stop: "to <stop> · 700 m · 2 min · 18:46".
The final arrival is on the route page. The map draws each stop as a dot ringed in the route's colour with its number.

### 5.2 At a stop

- **Reached:** within 30 m of its leg's end along the route while on it (as an arrival), or within 30 m of the road
  point or of the stop's own point (a forecourt) while it is within 300 m along. A stop passed within 30 m without
  stopping counts as reached.
- The banner turns green with the flag: "You've reached your stop", its name. A card shows the next point (name, distance,
  time, arrival) and "Guidance will resume when you drive off", with **End route** (ends the route) and **Continue** (ends the
  wait). Guidance is already on the next leg.
- **The route waits:** no re-plan within 150 m of the stop's point, nor while the car is slower than 1 m/s (with no
  speed, as from GNSS alone, the distance decides). A forecourt beside the road is off the route; a driver walking into
  the shop with the phone is not driving.
- **Going on:** the wait ends once the car has followed the next leg 100 m past the stop, or on **Continue**. Leaving
  another way, off the route and beyond 150 m, ends it too, and the rest of the trip is planned from there. A plan made
  while waiting (a stop added, removed or moved at the pump) starts at the car: the wait ends 100 m along it.

### 5.3 A stop left behind

- **On the route:** the car is 100 m beyond the stop along the route without having reached it (a stop down a side
  road the car drove past). Nothing is planned: the route goes on.
- **Off the route:** before an off-route plan, if the car came within 200 m of the next stop and is now 100 m further
  from it than that, the stop is behind: the new plan leaves it out. A car that leaves the route before coming near
  the stop gets a plan through it, as before.
- A card: "You passed the stop: <stop>", "Next: <next point>", ✕, and **Go back · +5 min**, the minutes from a plan
  through it and the rest of the trip, made at once (`searchBack`). A tap puts it back as the next stop and plans from
  the car (reason `stop-back`); not offered while the trip has five stops (none is dropped for it). The card goes
  after 2 km or on ✕.

### 5.4 Changing the trip while driving

Adding, removing or moving a stop plans again from the car at once (reason `stops`); the route waits for it as for a
re-plan. The new plan keeps to the route's roads where the stops allow, unless a fresh one is clearly faster
(ROUTING-SPEC §8.7). When that plan finds no way to a stop, the banner says so ("Couldn't find a route to the stop …",
until the next plan or 2 km on) and the route in force stays; a stop just added or put back is taken out again
(`route stop dropped`), since kept it would fail every re-plan after. A new destination from search, a pin or the car's screen
replaces the whole trip, as "Route here" does (Undo, §7.4).

## 6. Places along the route

### 6.1 In the search file (`tools/tiles/tiles/search.py`, SEARCH-SPEC §3)

- **Read:** nodes and ways (at their centroid) with `amenity` = fuel, charging_station, cafe, fast_food, restaurant,
  pharmacy, parking (fuel, charging and parking not with `access` = private, customers or no), named or not. Name:
  `name`, else `name:uk`, else `brand`.
- **Place, 16 B:** i32 lat, lon (1e-6°); u32 name (or none: the row shows the kind's word); u16 flags; u8 kind; u8
  reserved. Flags: 24/7 (open the whole week), and for fuel diesel, LPG, 92, 95 and 98 (`fuel:diesel`, `fuel:lpg`,
  `fuel:octane_92/95/98` = yes).
- **Opening hours** (`tools/tiles/tiles/hours.py`): `opening_hours` as the minutes of the week open, Monday 00:00 =
  0, in [start, end) ranges. Read: rules split by ";" (a later one replaces the days it names) or by "," before a
  weekday (adds to them); weekdays Mo–Su, ranges and lists in any case (PH dropped, a rule of PH alone skipped; none:
  every day); times H:MM-H:MM, several, past midnight into the next day (equal ends: the whole day; a trailing "+"
  read as the end given), off or closed; days no rule names are closed once a rule opens some day ("off" or "closed"
  alone: closed always; "Su off" or "PH off" alone says nothing of the other days: unknown). Anything else (months,
  dates, sunrise, comments) is unknown: the row says nothing rather than something wrong. Kyiv: 4,087 places tag it, 5 unread. In
  the file a section just before the places (SEARCH-SPEC §3.3): each place's schedule, each schedule once.
- **Cells:** sorted by a 0.01° grid cell, with a table of the used cells for a binary search; the places trailer
  (`"WTFP"`) just before the entrances' one, which stays last. Header flag 2. `tiles search-check` validates both. A
  file without the section has no places along the route; the page says to download the region again. Older apps
  read the file as before. Kyiv: 15,434 places, +3 % on the file.
- **Reader** (`SearchIndex.placesIn(box, kinds)`): the cell table read once, each latitude row of the box one read.

### 6.2 Kinds

| Kind | Tags | Label (uk) |
| --- | --- | --- |
| fuel | `amenity=fuel` | АЗС |
| charging | `amenity=charging_station` | Зарядні |
| cafe | `amenity=cafe` | Кафе |
| food | `amenity=fast_food`, `restaurant` | Їжа |
| pharmacy | `amenity=pharmacy` | Аптеки |
| parking | `amenity=parking` | Стоянки |

### 6.3 Query and detour (`src/nav/routing/along.ts`, `detour.ts`)

- **Which places** (`placesAlong`): those of the kind within 500 m of the route *ahead* of the car, the route read in
  5 km stretches, each stretch's box of cells read from the file. Each place is measured against the route's segments
  near it only (`RouteLine`, a 500 m grid); one whose closest point of the route is behind the car is left out (the
  car passed it), and so is one whose closest point is before the plan's start: a plan made from the car (any plan
  after the first, a stop added included) has no route behind the car to measure on. The distance shown is its
  projection's distance along the route from the car.
- **The list:** the first 10 by distance along the route; "Further along the route" adds the next 10 beyond the last.
- **Detour** (`DetourSearch`) per place, in list order, in slices after the list shows (a row waiting says "…"): from
  the route point 1 km before its projection (the car's progress point if nearer), driving, to the place; plus from the
  place, standing, to the route point 1 km after it (the next stop or the end if nearer); minus the route's own time
  between the two, searched as well: the plan's time is its average pace, and a stretch in a city centre is slower
  than a whole route with its avenues (a place on the route came out at +2 min). Each search is capped at 20,000
  states; a place it can't reach in that is left out. Under 30 s: "on the way"; otherwise "+n min" to the nearest
  minute, at least 1. A station on the driver's side costs about a minute and a half (turning in, its forecourt at
  15 km/h, turning out); one across a divided road 6–14 minutes (the U-turn) on Kyiv's avenues.
- **Search results** (adding a stop, §7.1): the same detours for the first 10 results, each projected on the route
  within 20 km, 2 km either side and 150,000 states a search.
- **Searched again** along a new plan or an alternative taken; the list goes with the page.

### 6.4 Side of the road

The side of the route the place is on, where its projection falls: left or right of the route's direction there;
within 15 m of the line, none. Rows show it ("right", "left"); a stop's maneuver, its voice and its car maneuver carry
it.

### 6.5 Parking (`parkingNear` in `along.ts`, `RouteService.findParking`, `parkAt`)

Parking is where the car is left to walk on, not a stop along the way: the kind lists car parks within 600 m (about 8
minutes' walk, straight line) of the destination, the nearest first, up to 10; then up to 3 near each stop, in the
trip's order, each car park once (for the destination first). None along the route ahead: those near the start are of
no use. No detours: the drive there is the trip's own. A row shows the straight walk to what it is for. Picked, the car
park takes that one's place: the destination (the route ends there, its stops kept) or the stop; planned from the car
(reason `stops`, note `route parking for the destination|a stop: …, was …`), with Undo (§7.4). It is named for what it
is for, "Parking near <destination or stop>", wherever the trip shows it (the trip, the banner, the car's screens,
Undo); its own name or address is its `detail`, under that name on the route page.

## 7. Screens

### 7.1 Route page (`src/app/route.tsx`, UI-SPEC §7.1)

- **With a route** (planned or being planned), the page opens on **Pull in on the way**, six large tiles (§6.2), each
  kind as its badge in the map's colour for its places (`CATEGORY_COLOR`: fuel and parking blue, parking the square
  sign, cafés and food orange, pharmacies violet; charging, with no map icon, green), as are the places on the way's
  chips and rows; then the trip, each mark a light-blue icon in a dark-blue circle like "Add a stop" (the route's
  colour is the map's): My location, each stop (kind's icon or number, name, "at 18:46", ≡, ✕), the destination with
  its arrival, **Add a stop**, the only name in bold; distance, time and arrival of what is left; **Stop guidance**. Typing searches as before.
- **Moving a stop** (`use-stop-drag.ts`, a stop or more): each stop's ≡ handle and the destination's drag the row, the
  page holding still; the rows it passes make room, and the drop puts it where its middle passed the others' (one
  plan, §5.4). What is dropped last is the destination, and the destination dropped earlier is a stop
  (`RouteService.moveStop` with `DESTINATION_KEY`). Screen readers get "earlier" and "later" actions on the handle
  instead.
- **Add a stop** opens the stop search, the route page pushed again over the trip (`/route?adding=1`): **Pull in on
  the way** first (its list goes back two pages, to the trip), then the field (the same index) with each result's
  detour in place of its straight-line distance, the least first once all ten are known; saved places with theirs. A
  result picked becomes a stop and the page goes back to the trip.
- A place picked opens its card on a page of its own (`/place`, `place-card.tsx`), so the back swipe slides back to
  the list it came from. A route on: **Add as a stop** beside Start guidance (not for a place already a stop); it goes
  back to the trip, the new stop's row glowing once. No route: **Add a stop** starts the route to it and opens the stop
  search in the card's place. Start guidance and "I'm here" go back to the map. A route planned or failed (not
  followed yet) opens the route page on its destination's card, in the page itself.
- Back on the route page after the trip changed under a card or the stop search, the search is cleared: the trip
  shows, not the results it was found in.

### 7.2 Along the way (`src/app/along.tsx`, a page like the route page)

Kind chips, the selected one filled; rows: icon, name, side and what the file knows ("right · diesel, 95, LPG ·
24/7", "left · open till 22:00", "closed till 8:00", "closed till Mon 8:00" when that is a day or more away; now
by the phone's clock and time zone), distance along the route, the detour ("on the way" in green). A place without a
name is titled by the address nearest it (within 150 m), else by its kind. A row is added as a stop at once, with Undo
(§7.4), and the page goes back to the trip, the new stop's row glowing once. Parking (§6.5): a note that the route
goes there instead, then sections "Near <destination>", "Near <stop>", each row with its walk ("350 m on foot").

### 7.3 Dropped pin (UI-SPEC §6.3)

While a route is on, the pin's card offers **Add as a stop** beside **Route here**. Either acts at once, without a
confirmation: the stop is added (planned where it adds least, §4), or the route is replaced; Undo follows (§7.4).

### 7.4 Undo (`src/components/route/trip-undo.ts`)

A trip change made in one tap is offered back for 10 s under the route banner, on the strip a saved place shows
(`UndoStrip`, save-feedback.tsx) laid on the map's glass: "Stop added: <name>" or "New route: <name>" and **Undo**. Undo
takes the stop out again, or plans the old trip again from the
car (its destination and the stops it hadn't reached). Offered for a stop added (from a pin, the route page, the places
on the way), for a route replaced (from a pin, the route page's Start guidance) and for parking picked (§6.5); none
when no route was on.

## 8. Voice (ROUTING-SPEC §8.5)

Recorded phrases, both languages (`npm run voice:render`):

- The `stop` maneuver, ahead and at it like a turn: "Через триста метрів, зупинка праворуч", "Зупинка праворуч" (left,
  right, or no side); "потім зупинка …" after a turn close before it.
- Reached: "Ви прибули до місця зупинки" / "You've reached your stop". Left behind: "Ви проїхали зупинку" /
  "You've passed your stop". Each as it comes (`Announcer`): a stop put back and missed again is said again; a plan
  made while waiting at a stop doesn't say it again.
- "і ви на місці" stays the destination's alone.

## 9. The car's screen (`car-guidance.ts`)

Display only: stops are added, removed and moved on the phone. The payload carries the stops ahead, each from the car
(name, distance, time), and whether the car is at one; a stop maneuver's kind carries its side (`stop-left`,
`stop-right`).

- **Android Auto** (ANDROID-AUTO-SPEC §4): the `Trip` gets a destination per stop ahead, then the destination. The
  stop maneuver is `TYPE_DESTINATION_LEFT`/`_RIGHT` (or plain), the flag icon. At a stop: the message card with the
  flag, "You've reached your stop: <name>", the session still navigating; the cluster's `Trip` keeps the points ahead
  and their times, without steps (`CarGuidanceLogic.tripLoading`: loading only while planned or planned again).
- **CarPlay** (CARPLAY-SPEC §4): one trip to the destination, on every iOS. Its estimates are the next stop's; at a
  stop the payload reads as arrived (`atStop`), shown as the arrival card ("You've reached your stop",
  `.arriveAtDestination`) with the estimates to the next stop or the destination (sent again when the stops change on
  the phone meanwhile), and the trip goes on from it
  (`CarPlayLogic.tripPlan`: `.atStop`). The `stop` kinds draw as the arrival. A stop left behind or a stop added keeps
  the trip; the route ended at a stop finishes it. Run in the iOS 26.3 Simulator through two stops 360 m apart to
  the destination: one trip started, the arrival card at each stop, the flag and its distance between them.
- **Not used: iOS 26.4's route segments** (`CPRouteSegment`, `CPNavigationWaypoint`, `addRouteSegments`). They are
  route sharing, the route and its stops handed to a car's own navigation, and change nothing on CarPlay's screen.
  Tried only in a car with route sharing: the Simulator's CarPlay from iOS 26.4 aborts on any map template
  (`CPSMapTemplateViewController _updateShareButtonVisibility`), and Xcode 27 has no Simulator CarPlay.
- A destination picked on the car replaces the trip (§5.4).

## 10. Trip log (TRIP-LOGGER-SPEC §6.3)

- Each plan's stops: `nav_route_stop` (plan, index, the stop's point, `at_m`, `at_s`, side, kind); its name is in the
  notes. Maneuver kind `stop`; plan reasons `stops`, `stop-back`. `tools/triplog` reads them (`route_stops`).
- Notes: `route to … via <stops>`, `route plan #n (reason): …, k stops`, `route stop added: <name> (<lat,lon>), i of
  n[, +m min]`, `route stop removed: …, i of n` (where it was), `route stop moved: …, i of n (was j)`, `route stop
  reached: … at <km>`, `route stop passed: … at <km>` (on the route) or `…, <m> m from it at the closest` (off it),
  `route stop left: …, next leg|go on|off the route`, `route stop back: …`, `route stop dropped: …, no route to it`,
  `route plan #n failed on the way to …`, `along the way: <kind>, n places in <km> (ms)`, `along the way: n detours in
  <ms>`.
- **Replays** rebuild a trip's stops from its log (`tools/replay/app-chain.ts`, `tripStopsAt`): the stops at a moment
  are the `nav_route_stop` rows of the plan in force, changed as the `route stop …` notes since say (a stop's key is
  its point, as the notes print it; a second stop at the same point `#2`). Before the log's first plan, those notes
  are undone: the stops reached or passed go back in front, those removed back where they were, those moved back
  (logs before 2026-11-02 lack where from), those added left out. A route the log misses (`routeBeforeLog`) is planned
  through the trip's stops at the log's start; logged plans replay as they are, already through their stops.

## 11. Verification

1. Jest: `trip.test.ts` (joined plans, stop maneuvers, the turnaround at a stop, failed legs, slices, sides, time,
   insertion), `stops-along.test.ts` (guidance at stops, passing on the route, the voice, places along, detours),
   `route-service-stops.test.ts` (waiting at a stop with the phone walking, going on, a plan made at a stop, leaving
   without a speed, left behind on and off the route, adding, moving, removing, a stop no road reaches, five at most,
   resume, places along, parking, search detours), `places.test.ts`, `stop-text.test.ts`, `car-guidance.test.ts`,
   `app-chain.test.ts` (stops rebuilt from a log); the Kotlin and Swift logic tests for the stop kinds; `test_hours.py`.
2. `npm run route -- --from … --via … --to …`: a trip from the command line.
3. The emulator: the route page, the list, a stop added from it and from a pin, the drive through a stop with the cards (GPS fixes along
   the route); Android Auto in the Desktop Head Unit.
4. On the road: a fuel stop on the driver's side, one across a divided road, a long stop with the engine off.

## 12. Open items

1. Charging stations' sockets and power.
2. CarPlay's one trip through the stops (§9) driven in a car: the arrival card at a stop and the trip going on.
