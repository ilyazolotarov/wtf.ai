// One Android Auto connection on the JS side (car-session.ts, docs/ANDROID-AUTO-SPEC.md §3), on fakes of the native
// module, the route service, the places and the voice.

import { en } from "@/i18n/en";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";
import type { PlacesSnapshot } from "@/services/navigation/places-store";

import type { CarAction } from "../../../../modules/android-auto/src/AndroidAutoModule";
import { carPlaces, runCarSession, type CarSessionDeps } from "../car-session";

const t = (key: keyof typeof en) => en[key];

function setup({ connected = true }: { connected?: boolean } = {}) {
  const calls: { method: string; arg: unknown }[] = [];
  let actionListener: ((e: CarAction) => void) | null = null;
  const routeListeners = new Set<() => void>();
  const placeListeners = new Set<() => void>();
  const voiceListeners = new Set<() => void>();
  let route: RouteSnapshot | null = null;
  let muted = false;
  let volume = 0.8;
  const placesSnapshot: PlacesSnapshot = {
    saved: [{ id: "home", title: "Home", detail: "Khreshchatyk 1", lat: 50.45, lon: 30.52, kind: "home", savedAt: 1 }],
    recent: [{ id: "search:1", title: "Lviv", detail: null, lat: 49.84, lon: 24.03, usedAt: 2 }],
  };
  const started: RouteDestination[] = [];
  const recents: string[] = [];
  const spoken: { route: RouteSnapshot | null; muted: boolean }[] = [];
  const notes: string[] = [];
  const carScreen: boolean[] = [];
  let claims = 0;
  const call = (method: string) => (arg: unknown) => {
    calls.push({ method, arg });
    return Promise.resolve();
  };
  const deps: CarSessionDeps = {
    native: {
      isConnected: () => connected,
      setLabels: call("setLabels"),
      setRoute: call("setRoute"),
      setPlaces: call("setPlaces"),
      setVoiceMuted: call("setVoiceMuted"),
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
    },
    places: {
      getSnapshot: () => placesSnapshot,
      subscribe: (l) => {
        placeListeners.add(l);
        return () => placeListeners.delete(l);
      },
      addRecent: (p) => recents.push(p.id),
    },
    strings: () => ({ language: "en", t }),
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
    },
    speedMps: () => 10,
    setCarScreen: (on) => carScreen.push(on),
    connect: () => notes.push("connect"),
    note: (text) => notes.push(text),
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
    started,
    recents,
    spoken,
    notes,
    carScreen,
    claims: () => claims,
    listeners: () => routeListeners.size + placeListeners.size + voiceListeners.size,
  };
}

const planning: RouteSnapshot = { destination: { lat: 49.84, lon: 24.03, name: "Lviv" }, status: "planning", planId: 1, replanning: false };

describe("car session", () => {
  test("at the start: the navigator on, the adapter connecting, and the car told its words, places, voice and route", () => {
    const s = setup();
    void runCarSession(s.deps);
    expect(s.carScreen).toEqual([true]);
    expect(s.notes).toEqual(["android auto connected", "connect"]);
    expect(s.claims()).toBe(1);
    const sent = Object.fromEntries(s.calls.map((c) => [c.method, c.arg]));
    expect(sent.setLabels).toMatchObject({ endRoute: en.stopGuidance, destinations: en.carDestinations, saved: en.savedPlaces });
    expect(sent.setPlaces).toEqual([
      { id: "home", title: "Home", detail: "Khreshchatyk 1", kind: "home" },
      { id: "search:1", title: "Lviv", detail: null, kind: "recent" },
    ]);
    expect(sent.setVoiceMuted).toBe(false);
    expect(sent.setRoute).toBeNull();
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

  test("the driver's actions on the car's screen", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.act({ action: "go", id: "search:1" });
    expect(s.recents).toEqual(["search:1"]);
    expect(s.started).toEqual([{ lat: 49.84, lon: 24.03, name: "Lviv", id: "search:1" }]);
    s.act({ action: "go", id: "gone" });
    expect(s.started).toHaveLength(1);

    s.setRoute(planning);
    s.act({ action: "end-route" });
    expect(s.calls.at(-1)).toEqual({ method: "setRoute", arg: null });

    s.act({ action: "toggle-voice" });
    expect(s.calls.at(-1)).toEqual({ method: "setVoiceMuted", arg: true });
  });

  test("no voice button with the volume at 0, and the voice said nothing then", () => {
    const s = setup();
    void runCarSession(s.deps);
    s.setVolume(0);
    expect(s.calls.at(-1)).toEqual({ method: "setVoiceMuted", arg: null });
    s.setRoute(planning);
    expect(s.spoken.at(-1)?.muted).toBe(true);
  });

  test("ends with the car's screen: the navigator let go, the voice and the listeners released", async () => {
    const s = setup();
    const session = runCarSession(s.deps);
    s.act({ action: "session-ended" });
    await session;
    expect(s.carScreen).toEqual([true, false]);
    expect(s.claims()).toBe(0);
    expect(s.listeners()).toBe(0);
    expect(s.hasListener()).toBe(false);
    expect(s.notes.at(-1)).toBe("android auto disconnected");
  });

  test("a car gone before the task listened ends it at once", async () => {
    const s = setup({ connected: false });
    await runCarSession(s.deps);
    expect(s.carScreen).toEqual([true, false]);
  });

  test("the car's list: saved places, then recent ones", () => {
    expect(carPlaces({ saved: [], recent: [] })).toEqual([]);
  });
});
