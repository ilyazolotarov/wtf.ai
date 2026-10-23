import { LocationSession, RELEASE_AFTER_LEAVING_MS, type LocationSessionDeps } from "@/services/location-session";

function harness(granted = true, always = false, startIn = "active") {
  let appState = startIn;
  let busy = false;
  const appListeners = new Set<(s: string) => void>();
  const busyListeners = new Set<() => void>();
  const calls: boolean[] = [];
  const notes: string[] = [];
  let timer: { fn: () => void; ms: number } | null = null;
  const deps: LocationSessionDeps = {
    set: async (on) => (calls.push(on), on && granted),
    always: async () => always,
    appState: () => appState,
    onAppState: (l) => (appListeners.add(l), () => appListeners.delete(l)),
    busy: () => busy,
    onBusy: (l) => (busyListeners.add(l), () => busyListeners.delete(l)),
    note: (t) => notes.push(t),
    setTimeout: (fn, ms) => (timer = { fn, ms }),
    clearTimeout: () => (timer = null),
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    session: new LocationSession(deps),
    calls, notes, flush,
    to: async (s: string) => {
      appState = s;
      appListeners.forEach((l) => l(s));
      await flush();
    },
    setBusy: (b: boolean) => {
      busy = b;
      busyListeners.forEach((l) => l());
    },
    timer: () => timer,
    fire: async () => {
      const t = timer!;
      timer = null;
      t.fn();
      await flush();
    },
  };
}

test("held whenever the app is in front, whatever is connected", async () => {
  const h = harness();
  h.session.start();
  await h.flush();
  expect(h.calls).toEqual([true]);
  expect(h.notes).toEqual(["location session held"]);
});

test("away from the app with no trip: let go after 30 min; a trip starting meanwhile keeps it", async () => {
  const h = harness();
  h.session.start();
  await h.to("background");
  expect(h.timer()?.ms).toBe(RELEASE_AFTER_LEAVING_MS);
  h.setBusy(true);
  expect(h.timer()).toBeNull();
  h.setBusy(false);
  expect(h.timer()).not.toBeNull();
  await h.fire();
  expect(h.calls).toEqual([true, false]);
  expect(h.notes.at(-1)).toBe("location session let go: 30 min away with no trip");
  // Back in front: held again.
  await h.to("active");
  expect(h.calls).toEqual([true, false, true]);
});

test("without location permission nothing is held, so nothing is let go", async () => {
  const h = harness(false);
  h.session.start();
  await h.to("background");
  expect(h.timer()).toBeNull();
  expect(h.notes).toEqual([]);
});

describe("with location Always (GNSS starts from the background without it)", () => {
  test("let go as soon as the app leaves the screen with no trip; a trip keeps it", async () => {
    const h = harness(true, true);
    h.setBusy(true);
    h.session.start();
    await h.flush();
    await h.to("background");
    expect(h.timer()).toBeNull();
    h.setBusy(false);
    expect(h.timer()?.ms).toBe(0);
    await h.fire();
    expect(h.calls).toEqual([true, false]);
    expect(h.notes.at(-1)).toBe("location session let go: away from the app with no trip (location Always)");
  });

  test("started in the background with nothing going on: the session joined at launch let go at once", async () => {
    const h = harness(true, true, "background");
    h.session.start();
    await h.flush();
    expect(h.calls).toEqual([false]);
    expect(h.notes).toEqual(["location session let go: started in the background with nothing going on (location Always)"]);
  });

  test("started in the background with a trip going on, or with While Using: kept", async () => {
    const busy = harness(true, true, "background");
    busy.setBusy(true);
    busy.session.start();
    await busy.flush();
    expect(busy.calls).toEqual([]);
    const whileUsing = harness(true, false, "background");
    whileUsing.session.start();
    await whileUsing.flush();
    expect(whileUsing.calls).toEqual([]);
  });
});
