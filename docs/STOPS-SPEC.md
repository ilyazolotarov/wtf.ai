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
| Trip | The car, then up to **5 stops**, then the destination. Each stretch between two points is a *leg*. |
| Way in | The bottom bar's **Route** tab (the route page). No map button, no strip under the banner. |
| Planning | One `RouteSearch` per leg, joined into one plan (§4). No via-point search inside A\*. |
| Guidance | One `RouteGuidance` over the joined plan; stops are points along it (§5). |
| Time at a stop | None added: arrival times assume no wait; at a stop the times count from now. |
| Stop passed by | Guidance goes on to the next point; a card offers to go back (§5.3). |
| Places along the route | A new section of the search file (§6.1), unnamed places included, with fuel types and 24/7. |
| Categories | Fuel, charging, cafe, food (fast food, restaurant), pharmacy, parking. |
| Detour | Two small searches per place near the route, not a full plan per place (§6.3). |
| Car's screen | Shows the trip's stops; adds, removes and reorders none (§9). |

## 3. Status

Not built. Order of work:

1. **Trips with stops:** planning, guidance, re-planning, passed stops, the route page's trip list, adding a stop
   from search, voice, logs, the car's screen showing them.
2. **Along the way:** the search file's places section, the along-the-route query, detours, the "Along the way" page,
   the stop preview on the map.
3. **From the map:** "Add as a stop" on a dropped pin's card.

## 4. The trip and its plan (`src/nav/routing/trip.ts`)

- **Trip:** `RouteDestination[]` of stops in order, then the destination. A stop keeps its `id` and name, its
  category (§6.2) when it came from one, and whether it was reached or passed. Reached and passed stops leave the
  plan. Without stops everything is as ROUTING-SPEC describes.
- **Legs:** the first leg starts from the car as ROUTING-SPEC §5.1 says (heading, turnaround). Each later leg starts
  where the previous one ended, as a parked car would: either direction of that edge, the one against the arrival
  costing the parked turnaround (60 s). Each leg's end is found as a destination is (§5.1 of ROUTING-SPEC).
- **Search:** the legs are planned one after another in the same slices (ROUTING-SPEC §5.4), each with the planner's
  limits. A leg that finds no route fails the plan, naming that point ("No route to <stop>"); the route page offers
  to remove it.
- **Joined plan:** the legs' `legs` and `coordinates` one after the other; `lengthM`, `durationS` and `offRoadM` summed;
  `stops`: for each stop its distance along the plan (`atM`), time from the start, and the side of the road it is on
  (§6.4). The plan of a trip without stops is the plan it is today.
- **Instructions:** each leg's maneuvers in order; between legs, one `stop` maneuver (with the stop's side) in place
  of the leg's `arrive` and the next leg's `depart`. The last leg ends with `arrive`.
- **Where a new stop goes:** a place picked along the route goes by its position along the route. One picked any other
  way (search, saved place, pin) goes between the two consecutive points where it adds the least straight-line
  distance. The driver can drag it elsewhere.
- **Alternatives** (ROUTING-SPEC §8.7) are searched for the leg to the next point only; the rest of the trip is
  shared, so "+4 min" still compares the whole trip.
- **Kept** in `route.active` (ROUTING-SPEC §8.2): the destination, the stops not yet reached or passed. An app
  restarted within 12 h plans the rest of the trip from the first position.

## 5. Guidance (`guidance.ts`, `route-service.ts`)

### 5.1 To a stop

The banner's maneuver lines are unchanged. Its last line counts to the next stop: "to <stop> · 700 m · 2 min ·
18:46". The final arrival time is on the route page. The map draws each stop as a white dot ringed in the route's
colour, with its category's icon (a stop without a category shows its number).

### 5.2 At a stop

- **Reached:** within 30 m of the stop's point along the route, as arrival is (ROUTING-SPEC §8.1). The banner turns
  green with the flag: "You're at the stop", its name. A card shows the next point (name, distance, time, arrival)
  and "We'll go on once you drive off", with **End here** (ends the route) and **Go on** (the next leg's guidance at
  once).
- **The route waits** while the car is at the stop: no off-route and no re-plan within 150 m of the stop's point, and
  none while the car stands (speed from the car under 1 m/s, or the adapter's link down). A forecourt beside the road
  is off the route, and a driver walking into the shop with the phone is not driving.
- **Moving on:** the next leg's guidance starts once the car has followed it for 100 m, or on **Go on**. Leaving the
  stop another way, beyond 150 m from it, plans the rest of the trip from there (reason `off-route`).
- A stop passed within 30 m without stopping counts as reached: the driver asked to pass by there.

### 5.3 A stop left behind

- **Passed:** the car, on the route, is 100 m beyond the stop along it without having been within 30 m of it (a
  station across a divided road). Guidance goes on to the next point; nothing is planned.
- A card: "<stop> is behind you", "Going on to <next point>", ✕, and **Back to <stop> · +5 min**. The minutes come
  from a plan from the car through the stop and the rest of the trip, made when the card shows. A tap makes that the
  route (reason `stop-back`). The card goes after 2 km or on ✕; the stop leaves the trip.
- **Leaving the route before a stop** plans again through every remaining point, the stop included, as today.

### 5.4 Changing the trip while driving

Adding, removing or reordering plans again from the car at once (reason `stops`). "Only here" on a place makes it
the destination and drops the stops. A new destination from search, a pin or the car's screen replaces the whole
trip, as "Route here" does today.

## 6. Places along the route

### 6.1 In the search file (`tools/tiles/tiles/search.py`, SEARCH-SPEC §3.3)

A new section after the entrances. A file without it has no places along the route, and the page says to download
the region again. Older apps read the file as before.

- **Read:** nodes and ways (at their centroid) with `amenity` = fuel, charging_station, cafe, fast_food, restaurant,
  pharmacy, parking (not `access` = private, customers or no), named or not.
- **Place, 16 B:** i32 lat, lon (1e-6°); u32 name (`name`, else `brand`, else NONE: the row shows the category's
  word); u16 flags; u8 category; u8 reserved. Flags: 24/7 (`opening_hours` = 24/7), and for fuel diesel, LPG,
  92, 95 and 98 (`fuel:diesel`, `fuel:lpg`, `fuel:octane_92/95/98` = yes).
- **Cells:** the places sorted by a 0.01° grid cell, then a table of the used cells (u32 cell key, u32 first place) in
  key order, for a binary search.
- **Placing it:** places, cells, then a 12 B trailer (u32 offset of the places, u32 count, `"WTFP"`) just before the
  entrances' trailer, which stays last. Header flag 2: places. `tiles search-check` validates both.

### 6.2 Categories

| Category | Tags | Label (uk) |
| --- | --- | --- |
| fuel | `amenity=fuel` | АЗС |
| charging | `amenity=charging_station` | Зарядні |
| cafe | `amenity=cafe` | Кафе |
| food | `amenity=fast_food`, `restaurant` | Їжа |
| pharmacy | `amenity=pharmacy` | Аптеки |
| parking | `amenity=parking` | Стоянки |

### 6.3 Query and detour (`src/nav/search/places-along.ts`, `src/nav/routing/detour.ts`)

- **Which places:** those of the category within 500 m of the route *ahead* of the car's progress point, the route
  read in 250 m steps, each step's cells read from the file. Each place is measured only against the route's
  segments near it (the 100 m grid of `route-via.ts`, ROUTING-SPEC §8.7). The place's distance is its projection's
  distance along the route from the car.
- **The list:** the first 10 by distance along the route; "Further along the route" adds the next 10.
- **Detour** per place, in list order, in slices after the list shows (a row waiting says "…"): from the route point
  1 km before its projection (the car's progress point if nearer) to the place, plus from the place to the route point
  1 km after (the next point if nearer), minus the route's own time between them. Each search is capped at 20,000
  states; a place it can't reach in that is left out. Under 30 s: "on the way"; otherwise "+n min", rounded up.
- **Recomputed** when the plan changes; cancelled when the page closes.

### 6.4 Side of the road

The side of the route the place is on, where its projection falls: left or right of the route's direction there;
within 15 m of the line, none. Rows show it ("right", "left"); a stop's voice and its car maneuver carry it.

## 7. Screens

### 7.1 Route page (`src/app/route.tsx`, UI-SPEC §7.1)

- **With a route:** the page opens on **Pull in on the way**, six large tiles (§6.2), then the trip: My position, each
  stop (category icon, name, "+4 min · at 18:46", a drag handle, ✕), the destination with its arrival, and **Add a
  stop**; then **Stop guidance**.
- **Before Start guidance:** a selected place's card also offers **Add a stop**, which turns the page into the same
  trip list with that place as the destination; the tiles show once the route is planned. Distance, time and arrival
  of the whole trip under the list.
- **Add a stop** opens the search (the same field and index) with each result's detour in place of its straight-line
  distance, sorted by it; saved places with theirs.

### 7.2 Along the way (`src/app/along.tsx`, a page like the route page)

Category chips, the selected one filled; rows: icon, name, side and what the file knows ("right · diesel, 95, LPG ·
24/7"), distance along the route, the detour ("on the way" in green). A row opens the stop preview.

### 7.3 Stop preview (the map)

The page closes; the map frames the car, the place and the way through it. The way through it is drawn as the route,
the current route as an alternative (UI-SPEC §6.3). Guidance follows the current route meanwhile. A card: category
icon, name, what it is, the side and the distance; the detour, the time there and the new arrival, from a plan through
the place (it replaces the estimate). **Add stop** makes that plan the route; **Only here** makes the place the
destination; ‹ back to the list.

### 7.4 Dropped pin (UI-SPEC §6.3)

While a route is on, the pin's card offers **Add as a stop** beside **Route here**.

## 8. Voice (ROUTING-SPEC §8.5)

New phrases in both voices and both languages, recorded with `npm run voice:render`:

- The `stop` maneuver, ahead and at it like any maneuver: "Через триста метрів, зупинка праворуч", "Зупинка
  праворуч" (left, right, or no side).
- Reached: "Ви на зупинці". Passed: "Зупинку пропущено".
- "і ви на місці" stays the destination's alone.

## 9. The car's screen

Display only: stops are added, removed and reordered on the phone.

- **Android Auto** (ANDROID-AUTO-SPEC §4): the `Trip` gets a destination per remaining point (stops, then the
  destination), each with its distance, time and arrival. The `stop` maneuver is a destination maneuver, left or
  right when known, with the stop's name. At a stop: a message card with the phone's words.
- **CarPlay** (CARPLAY-SPEC §4): a trip per leg. Reaching a stop shows `.arriveAtDestination` with "You're at the
  stop" and its name. When the next leg starts, that trip finishes and a new one to the next point starts. The
  estimates are the next point's.
- A destination picked on the car replaces the trip (§5.4).

## 10. Trip log (TRIP-LOGGER-SPEC §6.3)

- Each plan's stops: `nav_route_stop` (plan, index, lat, lon, `at_m`, side, category, name).
- Plan reasons `stops` and `stop-back`.
- Notes: `route stop added: <name> (<category>), <i> of <n>, +<min>`, `route stop removed|moved: …`,
  `route stop reached: <name> at <km>`, `route stop passed: <name> at <km>`, `route stop back: +<min>`,
  `route stop left: <name>, next leg` (when the next leg starts).
- `along the way: <category>, <n> places in <km> km; <n> detours in <ms>`.
- Replays rebuild the trip (`tools/replay/app-chain.ts`).

## 11. Verification

1. Unit tests: joined plans (legs, `stop` maneuvers, turnaround at a stop, a failed leg); insertion order; guidance
   reaching, waiting at (a forecourt off the route, the car standing, a walk with the phone), moving on from and
   passing a stop; re-plans through the remaining points; `route.active` with reached stops; the places section's
   reader against `search-check`'s fixture; the along query and sides; detours against a full plan through the place.
2. `npm run route -- --via lat,lon …`: a trip from the command line.
3. `npm run route:sim` with stops: reached, passed and left the right way; no false "off" at a stop.
4. On the road: a fuel stop on the driver's side, one across a divided road, a long stop with the engine off.

## 12. Open items

1. "Open now" from full `opening_hours`, not just 24/7.
2. Charging stations' sockets and power.
3. Whether CarPlay's SDK has its own multi-stop trips; a trip per leg until then.
