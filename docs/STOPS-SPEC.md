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
  first plan's failure names the stop (`failedStop`), the banner says "No route to <stop>", and the route page's ✕
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
- **Alternatives** (ROUTING-SPEC §8.7): searched for the first leg only, each joined with the rest of the trip, so
  "+4 min" compares the whole trip.
- **One frame per route:** every search of a route (plans, previews, the way back to a stop, detours) shares the graph
  reader, which projects what it decodes into one local frame. The route keeps one frame and makes a new one only
  when the car is 30 km from it; the searches beside the route's own stop then.
- **Kept** in `route.active`: the destination and the stops not yet reached or passed. An app restarted within 12 h
  plans the rest of the trip from the first position.

## 5. Guidance (`guidance.ts`, `route-service.ts`)

### 5.1 To a stop

`GuidanceStep` gives the next stop (`nextStop`), the distance and time to it, and the stops reached and passed. The
banner's maneuver lines are unchanged; its last line counts to the next stop: "to <stop> · 700 m · 2 min · 18:46".
The final arrival is on the route page. The map draws each stop as a dot ringed in the route's colour with its number;
a place previewed as a stop as "+".

### 5.2 At a stop

- **Reached:** within 30 m of its leg's end along the route while on it (as an arrival), or within 30 m of the road
  point or of the stop's own point (a forecourt) while it is within 300 m along. A stop passed within 30 m without
  stopping counts as reached.
- The banner turns green with the flag: "You're at the stop", its name. A card shows the next point (name, distance,
  time, arrival) and "We'll go on once you drive off", with **End here** (ends the route) and **Go on** (ends the
  wait). Guidance is already on the next leg.
- **The route waits:** no re-plan within 150 m of the stop's point, nor while the car is slower than 1 m/s. A
  forecourt beside the road is off the route; a driver walking into the shop with the phone is not driving.
- **Going on:** the wait ends once the car has followed the next leg 100 m past the stop, or on **Go on**. Leaving
  another way, off the route and beyond 150 m, ends it too, and the rest of the trip is planned from there.

### 5.3 A stop left behind

- **On the route:** the car is 100 m beyond the stop along the route without having reached it (a stop down a side
  road the car drove past). Nothing is planned: the route goes on.
- **Off the route:** before an off-route plan, if the car came within 200 m of the next stop and is now 100 m further
  from it than that, the stop is behind: the new plan leaves it out. A car that leaves the route before coming near
  the stop gets a plan through it, as before.
- A card: "Stop behind: <stop>", "Going on to <next point>", ✕, and **Back to it · +5 min**, the minutes from a plan
  through it and the rest of the trip, made at once (`searchBack`). A tap puts it back as the next stop and plans from
  the car (reason `stop-back`). The card goes after 2 km or on ✕.

### 5.4 Changing the trip while driving

Adding, removing or moving a stop plans again from the car at once (reason `stops`); the route waits for it as for a
re-plan. "Only here" on a place makes it the destination and drops the stops. A new destination from search, a pin or
the car's screen replaces the whole trip, as "Route here" does.

## 6. Places along the route

### 6.1 In the search file (`tools/tiles/tiles/search.py`, SEARCH-SPEC §3)

- **Read:** nodes and ways (at their centroid) with `amenity` = fuel, charging_station, cafe, fast_food, restaurant,
  pharmacy, parking (not `access` = private, customers or no), named or not. Name: `name`, else `name:uk`, else
  `brand`.
- **Place, 16 B:** i32 lat, lon (1e-6°); u32 name (or none: the row shows the kind's word); u16 flags; u8 kind; u8
  reserved. Flags: 24/7 (open the whole week), and for fuel diesel, LPG, 92, 95 and 98 (`fuel:diesel`, `fuel:lpg`,
  `fuel:octane_92/95/98` = yes).
- **Opening hours** (`tools/tiles/tiles/hours.py`): `opening_hours` as the minutes of the week open, Monday 00:00 =
  0, in [start, end) ranges. Read: rules split by ";" (a later one replaces the days it names) or by "," before a
  weekday (adds to them); weekdays Mo–Su, ranges and lists in any case (PH dropped, a rule of PH alone skipped; none:
  every day); times H:MM-H:MM, several, past midnight into the next day (equal ends: the whole day; a trailing "+"
  read as the end given), off or closed; days no rule names are closed. Anything else (months, dates, sunrise,
  comments) is unknown: the row says nothing rather than something wrong. Kyiv: 4,087 places tag it, 5 unread. In
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
- **Searched again** along a new plan; the list goes with the page.

### 6.4 Side of the road

The side of the route the place is on, where its projection falls: left or right of the route's direction there;
within 15 m of the line, none. Rows show it ("right", "left"); a stop's maneuver, its voice and its car maneuver carry
it.

## 7. Screens

### 7.1 Route page (`src/app/route.tsx`, UI-SPEC §7.1)

- **With a route** (planned or being planned), the page opens on **Pull in on the way**, six large tiles (§6.2), then
  the trip: My position, each stop (kind's icon or number, name, "at 18:46", ≡, ✕), the destination with its
  arrival, **Add a stop**; distance, time and arrival of what is left; **Stop guidance**. Typing searches as before.
- **Moving a stop** (`use-stop-drag.ts`, two stops or more): its ≡ handle drags the row, the page holding still; the
  stops it passes make room, and the drop puts it where its middle passed the others' (one plan, §5.4). Screen
  readers get "earlier" and "later" actions on the handle instead.
- **Add a stop** opens the search (the same field and index): each result's detour in place of its straight-line
  distance, the least first once all ten are known; saved places with theirs. A result picked becomes a stop.
- A selected place's card, a route on: **Add as a stop** beside Start guidance. No route: **Add a stop** starts the
  route to it and opens the stop search.

### 7.2 Along the way (`src/app/along.tsx`, a page like the route page)

Kind chips, the selected one filled; rows: icon, name, side and what the file knows ("right · diesel, 95, LPG ·
24/7", "left · open till 22:00", "closed till 8:00", "closed till Mon 8:00" when that is a day or more away; now
by the phone's clock and time zone), distance along the route, the detour ("on the way" in green). A row shows it on
the map (§7.3), its card the same words.

### 7.3 Stop preview (the map)

The pages close; the trip through the place is planned from the car (`previewStop`) and drawn as the route, the current
one quieter beneath it. Guidance follows the current route meanwhile. A card: the kind's icon, name, kind and what
the file knows; the detour, the time there and the new arrival, from that plan. **Add stop** takes it as the route
(no new plan, reason `stops`); **Only here** makes the place the destination; the kind's button goes back to the list;
✕ drops it.

### 7.4 Dropped pin (UI-SPEC §6.3)

While a route is on, the pin's card offers **Add as a stop** (a preview, §7.3) beside **Route here**.

## 8. Voice (ROUTING-SPEC §8.5)

Recorded phrases, both languages (`npm run voice:render`):

- The `stop` maneuver, ahead and at it like a turn: "Через триста метрів, зупинка праворуч", "Зупинка праворуч" (left,
  right, or no side); "потім зупинка …" after a turn close before it.
- Reached: "Ви на зупинці". Left behind: "Зупинку пропущено". Each once per stop (`Announcer`, by the stop's key).
- "і ви на місці" stays the destination's alone.

## 9. The car's screen (`car-guidance.ts`)

Display only: stops are added, removed and moved on the phone. The payload carries the stops ahead, each from the car
(name, distance, time), and whether the car is at one; a stop maneuver's kind carries its side (`stop-left`,
`stop-right`).

- **Android Auto** (ANDROID-AUTO-SPEC §4): the `Trip` gets a destination per stop ahead, then the destination. The
  stop maneuver is `TYPE_DESTINATION_LEFT`/`_RIGHT` (or plain), the flag icon. At a stop: the message card with the
  flag, "You're at the stop: <name>", the session still navigating.
- **CarPlay** (CARPLAY-SPEC §4): a trip per leg. The payload's destination and estimates are the next stop's; at a
  stop the route reads as arrived there ("You're at the stop", `.arriveAtDestination`); going on is a new destination,
  so a new trip (`CarPlayLogic.tripPlan`). The `stop` kinds draw as the arrival. A stop left behind changes the
  destination without an arrival: the trip is cancelled and the next one starts. Run in the iOS 26.3 Simulator: the
  estimates count to the stop, the flag ahead of it, the arrival card at it, the next trip a second after the wait
  ends (two stops 300 m apart, back to back), a stop left behind; no crash. The payload's `stops` and `atStop` are
  ignored by CarPlay's record.
- **One CarPlay trip through the stops:** iOS 26.4 has a trip of route segments, each between two waypoints
  (`CPRouteSegment`, `CPNavigationWaypoint`, `CPNavigationSession.addRouteSegments`, `currentSegment`), part of route
  sharing with the car's own navigation. Not used: the Simulator's CarPlay from iOS 26.4 (26.5 too) aborts on any
  map template (`CPSMapTemplateViewController _updateShareButtonVisibility`), so it can't be tried there (§12).
- A destination picked on the car replaces the trip (§5.4).

## 10. Trip log (TRIP-LOGGER-SPEC §6.3)

- Each plan's stops: `nav_route_stop` (plan, index, the stop's point, `at_m`, `at_s`, side, kind); its name is in the
  notes. Maneuver kind `stop`; plan reasons `stops`, `stop-back`. `tools/triplog` reads them (`route_stops`).
- Notes: `route to … via <stops>`, `route plan #n (reason): …, k stops`, `route stop added: <name> (<lat,lon>), i of
  n[, +m min]`, `route stop removed|moved: …`, `route stop reached: … at <km>`, `route stop passed: … at <km>` (on the
  route) or `…, <m> m from it at the closest` (off it), `route stop left: …, next leg|go on|off the route`, `route stop
  back: …`, `route plan #n failed on the way to …`, `along the way: <kind>, n places in <km> (ms)`, `along the way: n
  detours in <ms>`.
- **Replays** rebuild a trip's stops from its log (`tools/replay/app-chain.ts`, `tripStopsAt`): the stops at a moment
  are the `nav_route_stop` rows of the plan in force, less those the `route stop reached|passed` notes name since
  (a stop's key is its point, as the notes print it). Before the log's first plan, the stops reached or passed until
  then go back in front and those added until then are left out. A route the log misses (`routeBeforeLog`) is planned
  through the trip's stops at the log's start; logged plans replay as they are, already through their stops.

## 11. Verification

1. Jest: `trip.test.ts` (joined plans, stop maneuvers, the turnaround at a stop, failed legs, slices, sides, time,
   insertion), `stops-along.test.ts` (guidance at stops, passing on the route, the voice, places along, detours),
   `route-service-stops.test.ts` (waiting at a stop with the phone walking, going on, left behind on and off the
   route, adding, moving, removing, five at most, resume, places along, previews, search detours), `places.test.ts`,
   `car-guidance.test.ts`; the Kotlin and Swift logic tests for the stop kinds.
2. `npm run route -- --from … --via … --to …`: a trip from the command line.
3. The emulator: the route page, the list, a preview taken, the drive through a stop with the cards (GPS fixes along
   the route); Android Auto in the Desktop Head Unit.
4. On the road: a fuel stop on the driver's side, one across a divided road, a long stop with the engine off.

## 12. Open items

1. Charging stations' sockets and power.
2. CarPlay: one trip through the stops with iOS 26.4's route segments (§9), tried in a car (the Simulator can't show
   a map template from 26.4); a trip per leg below 26.4 either way.
