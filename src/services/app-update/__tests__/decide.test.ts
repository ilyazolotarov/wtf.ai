import {
  AUTO_MAP_BYTES,
  badges,
  mapAction,
  nativeUpdate,
  nextPrompt,
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

const MAP: MapUpdate = { region: "kyiv", name: { en: "Kyiv", uk: "Київ" }, osmDate: "2026-10-08", bytes: 50e6 };
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

  it("does nothing for a skipped OSM date, until a newer one", () => {
    expect(mapAction({ ...MAP, bytes: 1.7e9 }, true, "2026-10-08")).toBe("none");
    expect(mapAction(MAP, false, "2026-10-08")).toBe("none");
    expect(mapAction(MAP, false, "2026-10-01")).toBe("dot");
    expect(mapAction(null, true, null)).toBe("none");
  });
});

describe("nextPrompt", () => {
  const all: Found = { native: build(101), js: "upd-1", map: { ...MAP, bytes: 1.7e9 }, mapAction: "prompt" };

  it("asks about the native build first, then the JS update, then the map", () => {
    expect(nextPrompt(all, ctx())).toEqual({ kind: "native", key: "native:101" });
    expect(nextPrompt({ ...all, native: null }, ctx())).toEqual({ kind: "js", key: "js:upd-1" });
    expect(nextPrompt({ ...all, native: null, js: null }, ctx())).toEqual({ kind: "map", key: "map:kyiv:2026-10-08" });
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
