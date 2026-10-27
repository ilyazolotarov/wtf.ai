import {
  AUTO_MAP_BYTES,
  badges,
  mapAction,
  nativeUpdate,
  nextPrompt,
  RELOAD_BACKGROUND_MS,
  reloadBlocker,
  updateNotice,
  type AppBuildInfo,
  type Found,
  type MapUpdate,
} from "../decide";

const build = (n: number, runtime = `fp${n}`): AppBuildInfo => ({
  platform: "android",
  version: "1.0.0",
  build: n,
  runtime,
  commit: "c",
  date: "2026-10-10T00:00:00Z",
  file: `wtfai-${n}.apk`,
  size: 80e6,
  md5: "m",
  notes: [],
});

const MAP: MapUpdate = { region: "kyiv", name: { en: "Kyiv", uk: "Київ" }, osmDate: "2026-10-08", release: "a1b2c3d4", bytes: 50e6 };
const NONE: Found = { native: null, js: null, map: null, mapAction: "none" };
const ctx = (patch: Partial<Parameters<typeof nextPrompt>[1]> = {}) => ({ busy: false, now: 1000, snoozed: {}, shown: new Set<string>(), ...patch });

describe("nativeUpdate", () => {
  const own = { build: 100, runtime: "fp100", release: true };

  it("offers a newer build with another runtime", () => {
    expect(nativeUpdate(build(101), own)?.build).toBe(101);
  });

  it("ignores an older or same build, one with the app's runtime, and Debug builds", () => {
    expect(nativeUpdate(build(100, "other"), own)).toBeNull();
    expect(nativeUpdate(build(99), own)).toBeNull();
    // JS updates bring what that build has.
    expect(nativeUpdate(build(105, "fp100"), own)).toBeNull();
    expect(nativeUpdate(build(101), { ...own, release: false })).toBeNull();
    expect(nativeUpdate(build(101), { ...own, build: null })).toBeNull();
    expect(nativeUpdate(null, own)).toBeNull();
  });
});

describe("mapAction", () => {
  it("downloads small updates on an unmetered network by itself, asks for big ones, only marks them on mobile data", () => {
    expect(mapAction(MAP, true, null)).toBe("auto");
    expect(mapAction({ ...MAP, bytes: AUTO_MAP_BYTES }, true, null)).toBe("auto");
    expect(mapAction({ ...MAP, bytes: 1.7e9 }, true, null)).toBe("prompt");
    expect(mapAction(MAP, false, null)).toBe("dot");
    expect(mapAction({ ...MAP, bytes: 1.7e9 }, false, null)).toBe("dot");
  });

  it("does nothing for a skipped release, until other files come, even with the same OSM date", () => {
    expect(mapAction({ ...MAP, bytes: 1.7e9 }, true, "a1b2c3d4")).toBe("none");
    expect(mapAction(MAP, false, "a1b2c3d4")).toBe("none");
    // A forced rebuild of the same extract with a changed file: offered again.
    expect(mapAction({ ...MAP, release: "e5f60718", bytes: 1.7e9 }, true, "a1b2c3d4")).toBe("prompt");
    // A skip saved by an older app (an OSM date) matches no release.
    expect(mapAction(MAP, false, "2026-10-08")).toBe("dot");
    expect(mapAction(null, true, null)).toBe("none");
  });
});

describe("nextPrompt", () => {
  const all: Found = { native: build(101), js: "upd-1", map: { ...MAP, bytes: 1.7e9 }, mapAction: "prompt" };

  it("asks about the native build first, then the JS update, then the map", () => {
    expect(nextPrompt(all, ctx())).toEqual({ kind: "native", key: "native:101" });
    expect(nextPrompt({ ...all, native: null }, ctx())).toEqual({ kind: "js", key: "js:upd-1" });
    expect(nextPrompt({ ...all, native: null, js: null }, ctx())).toEqual({ kind: "map", key: "map:kyiv:a1b2c3d4" });
  });

  it("never interrupts while something is going on", () => {
    expect(nextPrompt(all, ctx({ busy: true }))).toBeNull();
  });

  it("skips a prompt shown this launch or held back by Later, until Later runs out", () => {
    expect(nextPrompt(all, ctx({ shown: new Set(["native:101"]) }))?.kind).toBe("js");
    expect(nextPrompt(all, ctx({ snoozed: { "native:101": 2000 } }))?.kind).toBe("js");
    expect(nextPrompt(all, ctx({ snoozed: { "native:101": 500 } }))?.kind).toBe("native");
    // A newer build is a new question.
    expect(nextPrompt({ ...all, native: build(102) }, ctx({ snoozed: { "native:101": 2000 } }))?.kind).toBe("native");
  });

  it("asks about a map only when it is too big to download by itself on an unmetered network", () => {
    expect(nextPrompt({ ...NONE, map: MAP, mapAction: "auto" }, ctx())).toBeNull();
    expect(nextPrompt({ ...NONE, map: MAP, mapAction: "dot" }, ctx())).toBeNull();
  });
});

describe("badges", () => {
  it("marks app updates and the maps that wait for the driver", () => {
    expect(badges(NONE)).toEqual({ app: false, maps: false, any: false });
    expect(badges({ ...NONE, js: "u" })).toEqual({ app: true, maps: false, any: true });
    expect(badges({ ...NONE, native: build(101) }).app).toBe(true);
    expect(badges({ ...NONE, map: MAP, mapAction: "dot" })).toEqual({ app: false, maps: true, any: true });
    expect(badges({ ...NONE, map: MAP, mapAction: "prompt" }).maps).toBe(true);
    // Coming by itself, or skipped: nothing to do.
    expect(badges({ ...NONE, map: MAP, mapAction: "auto" }).any).toBe(false);
    expect(badges({ ...NONE, map: MAP, mapAction: "none" }).any).toBe(false);
  });
});

describe("updateNotice", () => {
  it("announces each new build once, and takes the notice back when it is no longer an update", () => {
    expect(updateNotice(build(101), null)).toEqual({ show: 101, cancel: false });
    expect(updateNotice(build(101), 101)).toEqual({ show: null, cancel: false });
    expect(updateNotice(build(102), 101)).toEqual({ show: 102, cancel: false });
    expect(updateNotice(null, 101)).toEqual({ show: null, cancel: true });
    expect(updateNotice(null, null)).toEqual({ show: null, cancel: false });
  });
});

describe("reloadBlocker", () => {
  const idle = {
    jsPending: true,
    recorder: "idle" as const,
    route: false,
    link: "idle",
    speedMps: 0,
    downloading: false,
    backgroundSinceMs: 0,
    now: RELOAD_BACKGROUND_MS,
  };

  it("restarts into the update only in the background, with nothing going on", () => {
    expect(reloadBlocker(idle)).toBeNull();
    // Auto-connect looking for an adapter, a failed link, or one retrying after the adapter went quiet at a stop.
    expect(reloadBlocker({ ...idle, link: "discovering" })).toBeNull();
    expect(reloadBlocker({ ...idle, link: "error", speedMps: undefined })).toBeNull();
    expect(reloadBlocker({ ...idle, link: "reconnecting" })).toBeNull();
  });

  it("waits while the driver looks, drives, guides or links, and without an update", () => {
    expect(reloadBlocker({ ...idle, jsPending: false })).toBe("no update");
    expect(reloadBlocker({ ...idle, backgroundSinceMs: null })).toBe("in front");
    expect(reloadBlocker({ ...idle, now: RELOAD_BACKGROUND_MS - 1 })).toBe("in front");
    expect(reloadBlocker({ ...idle, recorder: "recording" })).toBe("trip recording");
    // The parked minutes after the engine stops are still the trip; an adapter up arms the next one.
    expect(reloadBlocker({ ...idle, recorder: "lingering" })).toBe("trip lingering");
    expect(reloadBlocker({ ...idle, recorder: "armed" })).toBe("trip armed");
    expect(reloadBlocker({ ...idle, route: true })).toBe("route");
    expect(reloadBlocker({ ...idle, carScreen: true })).toBe("car screen");
    expect(reloadBlocker({ ...idle, link: "standby" })).toBe("adapter standby");
    expect(reloadBlocker({ ...idle, link: "connecting" })).toBe("adapter connecting");
    expect(reloadBlocker({ ...idle, link: "polling" })).toBe("adapter polling");
    expect(reloadBlocker({ ...idle, speedMps: 5 })).toBe("moving");
    expect(reloadBlocker({ ...idle, downloading: true })).toBe("download");
  });
});
