// One Android Auto connection on the JS side (car-session.ts, docs/ANDROID-AUTO-SPEC.md §3), on fakes of the native
// module, the route service, the places, the held route, the search and the voice.

import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";
import type { Place, PlacesSnapshot } from "@/services/navigation/places-store";

import type { CarAction, CarNote, CarRequest } from "../car-types";
import { carNotice, carPlaces, NOTICE_CHECK_MS, runCarSession, type CarSessionDeps } from "../car-session";

const tEn = (key: keyof typeof en) => en[key];

const khreshchatyk: Place = { id: "search:a1", title: "Khreshchatyk, 22", detail: "Kyiv", lat: 50.447, lon: 30.522 };
const khreshchatykStreet: Place = { id: "search:e3", title: "Khreshchatyk", detail: "Kyiv", lat: 50.449, lon: 30.523 };
const ukrainky: Place[] = [
  { id: "search:a4", title: "Lesi Ukrainky Boulevard, 26", detail: "Kyiv", lat: 50.426, lon: 30.538 },
  { id: "search:a5", title: "Lesi Ukrainky Street, 26", detail: "Kyiv", lat: 50.525, lon: 30.59 },
];
const shevchenka: Place[] = [
  { id: "search:e7", title: "Shevchenka Street", detail: "Kyiv", lat: 50.44, lon: 30.51 },
  { id: "search:e8", title: "Shevchenka Street", detail: "Brovary", lat: 50.51, lon: 30.79 },
];
/** The offline search, faked: two queries known; coordinates are a point named by the house there. */
function fakeFind(text: string): Place[] {
  const point = /^(-?\d+\.\d+), (-?\d+\.\d+)$/.exec(text.trim());
  if (point) {
    const [lat, lon] = [Number(point[1]), Number(point[2])];
    return [{ id: `point:${lat},${lon}`, title: "Khreshchatyk, 1", detail: "Kyiv", lat, lon }];
  }
  const known: Record<string, Place[]> = {
    khreshchatyk: [khreshchatyk],
    shevchenka,
    "khreshchatyk st, 22, kyiv": [khreshchatyk, khreshchatykStreet],
    "lesi ukrainky, 26, kyiv": ukrainky,
  };
  return known[text.trim().toLowerCase()] ?? [];
}

/** The promises the session waits on (the permission, the native notes) settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({
  connected = true,
  located = true,
  testDrive = false,
  carPlay = false,
}: { connected?: boolean; located?: boolean; testDrive?: boolean; carPlay?: boolean } = {}) {
  const calls: { method: string; arg: unknown }[] = [];
  let actionListener: ((e: CarAction) => void) | null = null;
  const routeListeners = new Set<() => void>();
  const placeListeners = new Set<() => void>();
  const voiceListeners = new Set<() => void>();
  const heldListeners = new Set<() => void>();
  const languageListeners = new Set<() => void>();
  const frontListeners = new Set<() => void>();
  let route: RouteSnapshot | null = null;
  let muted = false;
  let volume = 0.8;
  let granted = located;
  let held: RouteDestination | null = null;
  let withoutAdapter = false;
  let positionSet = false;
  let language: "en" | "uk" = "en";
  let nativeNotes: CarNote[] = [];
  let request: CarRequest | null = null;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const placesSnapshot: PlacesSnapshot = {
    saved: [{ id: "home", title: "Home", detail: "Khreshchatyk 1", lat: 50.45, lon: 30.52, kind: "home", savedAt: 1 }],
    recent: [{ id: "search:1", title: "Lviv", detail: null, lat: 49.84, lon: 24.03, usedAt: 2 }],
  };
  const started: RouteDestination[] = [];
  const chosen: number[] = [];
  const recents: string[] = [];
  const spoken: { route: RouteSnapshot | null; muted: boolean }[] = [];
  const notes: string[] = [];
  const reports: string[] = [];
  const carScreen: boolean[] = [];
  let claims = 0;
  const testDrives: ("start" | "stop")[] = [];
  let hushes = 0;
  let retries = 0;
  const call = (method: string) => (arg: unknown) => {
    calls.push({ method, arg });
    return Promise.resolve();
  };
  const emitHeld = () => heldListeners.forEach((l) => l());
  const deps: CarSessionDeps = {
    name: carPlay ? "carplay" : "android auto",
    native: {
      isConnected: () => connected,
      // CarPlay has no test drive.
      isTestDrive: carPlay ? undefined : () => testDrive,
      setLabels: call("setLabels"),
      setRoute: call("setRoute"),
      setPlaces: call("setPlaces"),
      setVoiceMuted: call("setVoiceMuted"),
      setNotice: call("setNotice"),
      setSearch: call("setSearch"),
      openSearch: call("openSearch"),
      showMap: () => call("showMap")(null),
      takeRequest: () => {
        const taken = request;
        request = null;
        return Promise.resolve(taken);
      },
      takeNotes: () => {
        const taken = nativeNotes;
        nativeNotes = [];
        return Promise.resolve(taken);
      },
      addListener: (_event, listener) => {
        actionListener = listener;
        return { remove: () => (actionListener = null) };
      },
    },
    routes: {
      getSnapshot: () => route,
      subscribe: (l) => {
        routeListeners.add(l);
        return () => routeListeners.delete(l);
      },
      start: (d) => started.push(d),
      stop: () => {
        route = null;
        routeListeners.forEach((l) => l());
      },
      chooseAlternative: (index) => chosen.push(index),
    },
    places: {
      getSnapshot: () => placesSnapshot,
      subscribe: (l) => {
        placeListeners.add(l);
        return () => placeListeners.delete(l);
      },
      addRecent: (p) => recents.push(p.id),
    },
    held: {
      get: () => held,
      hold: (d) => {
        held = d;
        emitHeld();
      },
      take: () => {
        const d = held;
        held = null;
        if (d) emitHeld();
        return d;
      },
      subscribe: (l) => {
        heldListeners.add(l);
        return () => heldListeners.delete(l);
      },
    },
    withoutAdapter: () => withoutAdapter,
    positionSet: () => positionSet,
    strings: () => ({ language, t: (key) => (language === "uk" ? uk : en)[key] }),
    subscribeLanguage: (l) => {
      languageListeners.add(l);
      return () => languageListeners.delete(l);
    },
    subscribePhoneInFront: (l) => {
      frontListeners.add(l);
      return () => frontListeners.delete(l);
    },
    voice: {
      muted: () => muted,
      setMuted: (m) => {
        muted = m;
        voiceListeners.forEach((l) => l());
      },
      volume: () => volume,
      subscribe: (l) => {
        voiceListeners.add(l);
        return () => voiceListeners.delete(l);
      },
      claim: () => {
        claims++;
        return () => claims--;
      },
      update: (r, _speed, m) => spoken.push({ route: r, muted: m }),
      hush: () => hushes++,
    },
    speedMps: () => 10,
    find: fakeFind,
    away: () => "1 km",
    streetAt: () => null,
    testDrive: { start: () => testDrives.push("start"), stop: () => testDrives.push("stop") },
    located: () => Promise.resolve(granted),
    retryLocation: () => retries++,
    setCarScreen: (on) => carScreen.push(on),
    connect: () => notes.push("connect"),
    note: (text) => notes.push(text),
    report: (text) => reports.push(text),
    every: (ms, fn) => {
      expect(ms).toBe(NOTICE_CHECK_MS);
      const id = nextTimer++;
      timers.set(id, fn);
      return () => timers.delete(id);
    },
  };
  return {
    deps,
    calls,
    act: (e: CarAction) => actionListener!(e),
    hasListener: () => actionListener !== null,
    setRoute: (r: RouteSnapshot | null) => {
      route = r;
      routeListeners.forEach((l) => l());
    },
    setVolume: (v: number) => {
      volume = v;
      voiceListeners.forEach((l) => l());
    },
    grant: () => (granted = true),
    holdOnPhone: (d: RouteDestination) => {
      held = d;
      emitHeld();
    },
    setWithoutAdapter: (v: boolean) => (withoutAdapter = v),
    setPositionSet: (v: boolean) => (positionSet = v),
    setLanguage: (l: "en" | "uk") => {
      language = l;
      languageListeners.forEach((f) => f());
    },
    phoneInFront: () => frontListeners.forEach((f) => f()),
    addNativeNotes: (n: CarNote[]) => (nativeNotes = [...nativeNotes, ...n]),
    /** A place asked for, as the native side keeps it until taken; `announce`: its `request` action too. */
    ask: (r: CarRequest, announce = true) => {
      request = r;
      if (announce) actionListener!({ action: "request" });
    },
    searches: () => calls.filter((c) => c.method === "setSearch").map((c) => c.arg),
    opened: () => calls.filter((c) => c.method === "openSearch").map((c) => c.arg),
    mapsShown: () => calls.filter((c) => c.method === "showMap").length,
    tick: () => [...timers.values()].forEach((f) => f()),
    timers: () => timers.size,
    held: () => held,
    notices: () => calls.filter((c) => c.method === "setNotice").map((c) => c.arg),
    started,
    chosen,
    recents,
    spoken,
    notes,
    reports,
    carScreen,
    testDrives,
    claims: () => claims,
    hushes: () => hushes,
    retries: () => retries,
    listeners: () =>
      routeListeners.size + placeListeners.size + voiceListeners.size + heldListeners.size + languageListeners.size + frontListeners.size,
  };
}

const planning: RouteSnapshot = { destination: { lat: 49.84, lon: 24.03, name: "Lviv" }, status: "planning", planId: 1, replanning: false };
const lviv = { lat: 49.84, lon: 24.03, name: "Lviv", id: "search:1" };

describe("car session", () => {
  test("at the start: the navigator on, the adapter connecting, and the car told its words, places, voice and route", () => {
    const s = setup();
    void runCarSession(s.deps);
    expect(s.carScreen).toEqual([true]);
    expect(s.notes).toEqual(["android auto connected", "connect"]);
    expect(s.claims()).toBe(1);
    const sent = Object.fromEntries(s.calls.map((c) => [c.method, c.arg]));
    expect(sent.setLabels).toEqual({
      endRoute: en.stopGuidance,
      destinations: en.carDestinations,
      saved: en.savedPlaces,
      recent: en.recentPlaces,
      noDestinations: en.carNoDestinations,
      search: en.carSearch,
      searchHint: en.searchPlaces,
      noResults: en.noSearchResults,
      checkPhone: en.carCheckPhone,
      notification: en.carNotification,
      routes: en.carRoutes,
      thisRoute: en.carThisRoute,
      cancel: en.cancel,
      close: en.close,
    });
    expect(sent.setPlaces).toEqual([
      { id: "home", title: "Home", detail: "Khreshchatyk 1", kind: "home" },
      { id: "search:1", title: "Lviv", detail: null, kind: "recent" },
    ]);
    expect(sent.setVoiceMuted).toBe(false);
    expect(sent.setRoute).toBeNull();
    // Nothing to do first, said even so: the native side may keep a notice from a JS runtime before a reload. And no
    // checks running for it.
    expect(sent.setNotice).toBeNull();
    expect(s.timers()).toBe(0);
  });

  test("CarPlay's connection is the same session, in the trip log as carplay, without a test drive", () => {
    const s = setup({ carPlay: true });
    void runCarSession(s.deps);
    expect(s.notes).toEqual(["carplay connected", "connect"]);
    expect(s.testDrives).toEqual([]);
    s.act({ action: "end-route" });
    expect(s.notes.at(-1)).toBe("carplay: route ended on the car's screen");
    s.act({ action: "session-ended" });
    expect(s.notes.at(-1)).toBe("carplay disconnected");
  });

  test("the route goes to the car and to the car's voice as it changes; the words only once", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.setRoute(planning);
    s.setRoute({ ...planning, planId: 2 });
    const routes = s.calls.filter((c) => c.method === "setRoute").map((c) => c.arg);
    expect(routes).toEqual([null, expect.objectContaining({ status: "planning", destinationName: "Lviv" }), expect.objectContaining({ status: "planning" })]);
    expect(s.spoken.map((x) => x.route?.planId ?? null)).toEqual([null, 1, 2]);
    expect(s.calls.filter((c) => c.method === "setLabels")).toHaveLength(1);
  });

  test("the route's end stops what the voice was saying", () => {
    const s = setup();
    void runCarSession(s.deps);
    expect(s.hushes()).toBe(0);
    s.setRoute(planning);
    expect(s.hushes()).toBe(0);
    s.setRoute(null);
    expect(s.hushes()).toBe(1);
  });

  test("the driver's actions on the car's screen", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.act({ action: "go", id: "search:1" });
    expect(s.recents).toEqual(["search:1"]);
    expect(s.started).toEqual([lviv]);
    s.act({ action: "go", id: "gone" });
    expect(s.started).toHaveLength(1);

    s.setRoute(planning);
    s.act({ action: "end-route" });
    expect(s.calls.at(-1)).toEqual({ method: "setRoute", arg: null });

    s.act({ action: "toggle-voice" });
    expect(s.calls.at(-1)).toEqual({ method: "setVoiceMuted", arg: true });
  });

  test("a route picked in the car's routes list is followed", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.act({ action: "choose-alternative", index: 1 });
    expect(s.chosen).toEqual([1]);
    expect(s.notes.at(-1)).toBe("android auto: alternative 1 picked on the car's screen");
  });

  test("no voice button with the volume at 0, and the voice said nothing then", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.setVolume(0);
    expect(s.calls.at(-1)).toEqual({ method: "setVoiceMuted", arg: null });
    s.setRoute(planning);
    expect(s.spoken.at(-1)?.muted).toBe(true);
  });

  test("the app's language changed on the phone: the car's words, route and notice follow", async () => {
    const s = setup({ located: false });
    void runCarSession(s.deps);
    await settle();
    s.setRoute(planning);
    s.setLanguage("uk");
    const labels = s.calls.filter((c) => c.method === "setLabels").map((c) => c.arg);
    expect(labels).toEqual([expect.objectContaining({ endRoute: en.stopGuidance }), expect.objectContaining({ endRoute: uk.stopGuidance })]);
    expect(s.calls.filter((c) => c.method === "setRoute").at(-1)?.arg).toMatchObject({ message: uk.planningRoute });
    expect(s.notices().at(-1)).toMatchObject({ kind: "location", title: uk.locationOff });
  });

  describe("location permission", () => {
    test("missing: the car says so, with the button to ask, and checks again now and then", async () => {
      const s = setup({ located: false });
      void runCarSession(s.deps);
      await settle();
      expect(s.notices()).toEqual([null, { kind: "location", title: en.locationOff, text: en.carLocationNeeded, action: en.carAllowLocation }]);
      expect(s.notes).toContain("android auto: no location permission");
      expect(s.timers()).toBe(1);
      // Still missing: nothing new for the car.
      s.tick();
      await settle();
      expect(s.notices()).toHaveLength(2);

      // Allowed on the phone, seen by the next check: the notice gone, GNSS tried again, the checks stopped.
      s.grant();
      s.tick();
      await settle();
      expect(s.notices().at(-1)).toBeNull();
      expect(s.retries()).toBe(1);
      expect(s.notes).toContain("android auto: location allowed");
      expect(s.timers()).toBe(0);
    });

    test("the car's request answered, or the phone's app in front: checked at once", async () => {
      const s = setup({ located: false });
      void runCarSession(s.deps);
      await settle();
      s.act({ action: "permission" });
      await settle();
      expect(s.retries()).toBe(0);
      s.grant();
      s.act({ action: "permission" });
      await settle();
      expect(s.notices().at(-1)).toBeNull();
      expect(s.retries()).toBe(1);

      const t = setup({ located: false });
      void runCarSession(t.deps);
      await settle();
      t.grant();
      t.phoneInFront();
      await settle();
      expect(t.notices().at(-1)).toBeNull();
      expect(t.retries()).toBe(1);
    });

    test("granted from the start: no notice, no retry", async () => {
      const s = setup();
      void runCarSession(s.deps);
      await settle();
      expect(s.notices()).toEqual([null]);
      expect(s.retries()).toBe(0);
    });
  });

  describe("a route without an adapter", () => {
    test("picked on the car: held for the driver's word, which the car's button gives", async () => {
      const s = setup();
      void runCarSession(s.deps);
      await settle();
      s.setWithoutAdapter(true);
      s.setRoute(planning);
      s.act({ action: "go", id: "search:1" });
      expect(s.started).toEqual([]);
      expect(s.calls.filter((c) => c.method === "setRoute").at(-1)?.arg).toBeNull();
      expect(s.held()).toEqual(lviv);
      expect(s.notices().at(-1)).toEqual({
        kind: "held-route",
        title: en.carHeldTitle,
        text: en.carHeldSetPosition,
        action: en.noAdapterRouteAgree,
      });
      // The position set on the phone meanwhile: seen by the next check.
      s.setPositionSet(true);
      s.tick();
      expect(s.notices().at(-1)).toMatchObject({ text: en.carHeldFollow });

      s.act({ action: "confirm-held" });
      expect(s.started).toEqual([lviv]);
      expect(s.held()).toBeNull();
      expect(s.notices().at(-1)).toBeNull();
      expect(s.timers()).toBe(0);
    });

    test("held on the phone: shown on the car too; the car's close button drops it", async () => {
      const s = setup();
      void runCarSession(s.deps);
      await settle();
      s.holdOnPhone(lviv);
      expect(s.notices().at(-1)).toMatchObject({ kind: "held-route" });
      s.act({ action: "cancel-held" });
      expect(s.held()).toBeNull();
      expect(s.started).toEqual([]);
      expect(s.notices().at(-1)).toBeNull();
      // Nothing held: the button does nothing.
      s.act({ action: "confirm-held" });
      expect(s.started).toEqual([]);
    });

    test("with the adapter connected, a route picked on the car starts at once", () => {
      const s = setup();
      void runCarSession(s.deps);
      s.act({ action: "go", id: "search:1" });
      expect(s.started).toEqual([lviv]);
      expect(s.held()).toBeNull();
    });
  });

  test("the native side's notes go into the trip log, its problems reported too", async () => {
    const s = setup();
    s.addNativeNotes([{ text: "map surface 1280x720 at 160 dpi", problem: false }]);
    void runCarSession(s.deps);
    await settle();
    expect(s.notes).toContain("android auto: map surface 1280x720 at 160 dpi");
    s.addNativeNotes([{ text: "map surface failed: IllegalStateException: no React host", problem: true }]);
    s.act({ action: "notes" });
    await settle();
    expect(s.notes).toContain("android auto: map surface failed: IllegalStateException: no React host");
    expect(s.reports).toEqual(["android auto: map surface failed: IllegalStateException: no React host"]);
  });

  test("ends with the car's screen: the navigator let go, the voice, the checks and the listeners released", async () => {
    const s = setup({ located: false });
    const session = runCarSession(s.deps);
    await settle();
    expect(s.timers()).toBe(1);
    s.act({ action: "session-ended" });
    await session;
    expect(s.carScreen).toEqual([true, false]);
    expect(s.claims()).toBe(0);
    expect(s.listeners()).toBe(0);
    expect(s.timers()).toBe(0);
    expect(s.hasListener()).toBe(false);
    expect(s.notes.at(-1)).toBe("android auto disconnected");
  });

  test("the car's test drive: started when the car asks for it, or asked before; stopped with the car's screen", async () => {
    const s = setup();
    const session = runCarSession(s.deps);
    expect(s.testDrives).toEqual([]);
    s.act({ action: "test-drive" });
    expect(s.testDrives).toEqual(["start"]);
    s.act({ action: "session-ended" });
    await session;
    expect(s.testDrives).toEqual(["start", "stop"]);

    const asked = setup({ testDrive: true });
    void runCarSession(asked.deps);
    expect(asked.testDrives).toEqual(["start"]);
  });

  test("a car gone before the task listened ends it at once", async () => {
    const s = setup({ connected: false });
    await runCarSession(s.deps);
    expect(s.carScreen).toEqual([true, false]);
  });

  describe("search, and places asked for", () => {
    test("the search screen gets answers for the text typed; a result picked is routed to", () => {
      const s = setup();
      void runCarSession(s.deps);
      s.act({ action: "search", text: "Khreshchatyk" });
      expect(s.searches().at(-1)).toEqual({
        query: "Khreshchatyk",
        results: [{ id: "search:a1", title: "Khreshchatyk, 22", detail: "Kyiv · 1 km", kind: "result" }],
      });
      s.act({ action: "go", id: "search:a1" });
      expect(s.started).toEqual([{ lat: 50.447, lon: 30.522, name: "Khreshchatyk, 22", id: "search:a1" }]);
      expect(s.recents).toEqual(["search:a1"]);
      expect(s.notes).toContain("android auto: search result picked on the car's screen");
      s.act({ action: "search", text: " " });
      expect(s.searches().at(-1)).toEqual({ query: " ", results: [] });
    });

    test("asked to go somewhere with one answer: gone to, also when asked before the task listened", async () => {
      const s = setup();
      s.ask({ navigate: true, uri: "geo:0,0?q=Khreshchatyk&entry=assistant" }, false);
      void runCarSession(s.deps);
      await settle();
      expect(s.started).toEqual([{ lat: 50.447, lon: 30.522, name: "Khreshchatyk, 22", id: "search:a1" }]);
      expect(s.opened()).toEqual([]);
      expect(s.notes).toContain("android auto: place asked for on the car");
    });

    test("several answers, or asked only to look: the search screen shows them to pick from", async () => {
      const s = setup();
      void runCarSession(s.deps);
      s.ask({ navigate: true, uri: "geo:0,0?q=Shevchenka" });
      await settle();
      expect(s.started).toEqual([]);
      expect(s.searches().at(-1)).toMatchObject({ query: "Shevchenka", results: [{ id: "search:e7" }, { id: "search:e8" }] });
      expect(s.opened()).toEqual(["Shevchenka"]);
      s.act({ action: "go", id: "search:e8" });
      expect(s.started).toEqual([{ lat: 50.51, lon: 30.79, name: "Shevchenka Street", id: "search:e8" }]);

      s.ask({ navigate: false, uri: "geo:0,0?q=Khreshchatyk" });
      await settle();
      expect(s.opened().at(-1)).toBe("Khreshchatyk");
      expect(s.started).toHaveLength(1);
    });

    test("a point asked for is gone to by the name the link gave; without an adapter it is held", async () => {
      const s = setup();
      void runCarSession(s.deps);
      s.ask({ navigate: true, uri: "geo:50.45,30.52?q=Maidan" });
      await settle();
      expect(s.started).toEqual([{ lat: 50.45, lon: 30.52, name: "Maidan", id: "point:50.45,30.52" }]);
      // A list open over the map goes: the route shows.
      expect(s.mapsShown()).toBe(1);

      s.setWithoutAdapter(true);
      s.ask({ navigate: true, uri: "google.navigation:q=50.46,30.53" });
      await settle();
      expect(s.started).toHaveLength(1);
      expect(s.held()).toEqual({ lat: 50.46, lon: 30.53, name: "Khreshchatyk, 1", id: "point:50.46,30.53" });
      // …and the card asking for the driver's word.
      expect(s.mapsShown()).toBe(2);
      expect(s.notes).toContain("android auto: place asked for on the car, held: no adapter");
    });

    test("the assistant's full address is searched as the index holds it, then with less of it", async () => {
      const s = setup();
      const asked: string[] = [];
      const find = s.deps.find;
      s.deps.find = (text) => {
        asked.push(text);
        return find(text);
      };
      void runCarSession(s.deps);
      s.ask({ navigate: true, uri: "geo:0,0?q=Lavra,+Khreshchatyk,+22,+Kyiv,+Ukraine,+01001" });
      await settle();
      expect(asked).toEqual(["Lavra, Khreshchatyk, 22, Kyiv", "Khreshchatyk, 22, Kyiv", "Lavra"]);
      expect(s.started).toEqual([]);
      expect(s.opened()).toEqual(["Lavra, Khreshchatyk, 22, Kyiv"]);
      expect(s.searches().at(-1)).toEqual({ query: "Lavra, Khreshchatyk, 22, Kyiv", results: [] });

      asked.length = 0;
      s.ask({ navigate: true, uri: "geo:0,0?q=Khreshchatyk,+Kyiv,+Ukraine" });
      await settle();
      expect(asked).toEqual(["Khreshchatyk, Kyiv"]);
    });

    test("one house among the answers is gone to; two are shown to pick from", async () => {
      const s = setup();
      void runCarSession(s.deps);
      s.ask({ navigate: true, uri: "geo:0,0?q=Khreshchatyk+St,+22,+Kyiv,+Ukraine,+01001" });
      await settle();
      expect(s.started).toEqual([{ lat: 50.447, lon: 30.522, name: "Khreshchatyk, 22", id: "search:a1" }]);
      s.ask({ navigate: true, uri: "geo:0,0?q=Lesi+Ukrainky,+26,+Kyiv,+Ukraine" });
      await settle();
      expect(s.started).toHaveLength(1);
      expect(s.opened()).toEqual(["Lesi Ukrainky, 26, Kyiv"]);
      // Shown to pick from: the search, not the map.
      expect(s.mapsShown()).toBe(1);
    });

    test("a link that asks for nothing is noted, not acted on", async () => {
      const s = setup();
      void runCarSession(s.deps);
      s.ask({ navigate: true, uri: "geo:0,0" });
      await settle();
      expect(s.started).toEqual([]);
      expect(s.opened()).toEqual([]);
      expect(s.notes).toContain("android auto: a place asked for, not understood");
    });
  });

  test("the car's list: saved places, then recent ones", () => {
    expect(carPlaces({ saved: [], recent: [] })).toEqual([]);
  });

  test("the notice: location first, then a held route; nothing while the permission is unknown", () => {
    expect(carNotice(null, null, false, tEn)).toBeNull();
    expect(carNotice(true, null, false, tEn)).toBeNull();
    expect(carNotice(false, lviv, true, tEn)).toMatchObject({ kind: "location" });
    expect(carNotice(null, lviv, true, tEn)).toMatchObject({ kind: "held-route", text: en.carHeldFollow });
  });
});
