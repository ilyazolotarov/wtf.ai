// Sharing the car's position with Waze and Google Maps (ANDROID-SPEC §8), with the native module faked.

import type { ShareSetup } from "../../../../modules/position-share/src/PositionShareModule";
import type { PositionEstimate } from "@/nav/position/types";

import { PositionShareService, type PositionShareNative, type ShareNotice } from "../position-share-service";

const READY: ShareSetup = { developerOptions: true, mockLocationApp: true, playServices: true, navigators: ["com.waze"] };

const dot = (patch: Partial<PositionEstimate> = {}): PositionEstimate => ({
  lat: 50.45,
  lon: 30.52,
  headingRad: 1,
  speedMps: 12,
  accuracyM: 18,
  source: "dr",
  trust: "UNTRUSTED",
  timestamp: 0,
  ...patch,
});

/** The trip notes without the gps takeover's (tested on their own). */
const shareNotes = (notes: string[]) => notes.filter((n) => !n.startsWith("position share gps"));

/** Lets the service's start/stop promises settle. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function harness({ setup = READY, enabled = true, native = true }: { setup?: ShareSetup; enabled?: boolean; native?: boolean } = {}) {
  let position: PositionEstimate | null = null;
  let trip = false;
  let on = enabled;
  let now = 1_000_000;
  const positionListeners = new Set<() => void>();
  const tripListeners = new Set<() => void>();
  const enabledListeners = new Set<() => void>();
  const errorListeners: ((e: { code: string; message: string }) => void)[] = [];
  const notices: (ShareNotice | null)[] = [];
  const notes: string[] = [];
  let notifyResult = true;
  const fake = {
    setup,
    getSetup: jest.fn((): ShareSetup => fake.setup),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    publish: jest.fn((..._args: unknown[]) => true),
    setGpsTakeover: jest.fn((_on: boolean): string | null => null),
    readBack: jest.fn(async () => null as Awaited<ReturnType<PositionShareNative["readBack"]>>),
    addListener: jest.fn((_event: "onShareError", listener: (e: { code: string; message: string }) => void) => {
      errorListeners.push(listener);
      return { remove: () => undefined };
    }),
  };
  const add = (set: Set<() => void>) => (listener: () => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const service = new PositionShareService({
    native: native ? fake : null,
    position: { getSnapshot: () => position, subscribe: add(positionListeners) },
    trip: { active: () => trip, subscribe: add(tripListeners) },
    enabled: { get: () => on, subscribe: add(enabledListeners) },
    notify: (notice) => {
      notices.push(notice);
      return notifyResult;
    },
    note: (text) => notes.push(text),
    nowMs: () => now,
  });
  return {
    service,
    native: fake,
    notices,
    notes,
    setPosition(p: PositionEstimate | null) {
      position = p;
      positionListeners.forEach((l) => l());
    },
    async setTrip(active: boolean) {
      trip = active;
      tripListeners.forEach((l) => l());
      await settle();
    },
    async setEnabled(value: boolean) {
      on = value;
      enabledListeners.forEach((l) => l());
      await settle();
    },
    advance(ms: number) {
      now += ms;
    },
    failNotify(fail: boolean) {
      notifyResult = !fail;
    },
    emitError(code: string, message: string) {
      errorListeners.forEach((l) => l({ code, message }));
    },
  };
}

describe("PositionShareService", () => {
  test("a trip with the car turns mock mode on, shares the dot about once a second, and turns it off at the end", async () => {
    const h = harness();
    expect(h.service.getSnapshot().state).toBe("ready");
    await h.setTrip(true);
    expect(h.native.start).toHaveBeenCalledTimes(1);
    expect(h.notices.at(-1)).toBe("waiting");

    h.setPosition(dot());
    expect(h.native.publish).toHaveBeenCalledWith({ lat: 50.45, lon: 30.52, accuracyM: 18, speedMps: 12, courseRad: 1 });
    expect(h.service.getSnapshot()).toMatchObject({ state: "sharing", hold: null, last: { accuracyM: 18 } });
    // GPS isn't trusted: the notification says the other apps get the car's position.
    expect(h.notices.at(-1)).toBe("car");

    h.advance(500);
    h.setPosition(dot({ lat: 50.4501 }));
    expect(h.native.publish).toHaveBeenCalledTimes(1);
    h.advance(500);
    h.setPosition(dot({ lat: 50.4502, trust: "TRUSTED" }));
    expect(h.native.publish).toHaveBeenCalledTimes(2);
    expect(h.notices.at(-1)).toBe("gps");

    await h.setTrip(false);
    expect(h.native.stop).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot()).toMatchObject({ state: "ready", last: null });
    expect(h.notices.at(-1)).toBeNull();
    expect(shareNotes(h.notes)).toEqual(["position share on", "position share off"]);
  });

  test("nothing is invented: a position the navigator didn't publish again isn't sent again", async () => {
    const h = harness();
    await h.setTrip(true);
    const p = dot();
    h.setPosition(p);
    h.advance(5_000);
    h.setPosition(p);
    expect(h.native.publish).toHaveBeenCalledTimes(1);
  });

  test("an uncertain dot is held and the driver told; it is shared again once well inside the limit", async () => {
    const h = harness();
    await h.setTrip(true);
    h.setPosition(dot({ accuracyM: 260 }));
    expect(h.native.publish).not.toHaveBeenCalled();
    expect(h.service.getSnapshot()).toMatchObject({ state: "holding", hold: "uncertain" });
    expect(h.notices.at(-1)).toBe("uncertain");
    h.advance(1_000);
    h.setPosition(dot({ accuracyM: 170 }));
    expect(h.native.publish).not.toHaveBeenCalled();
    h.advance(1_000);
    h.setPosition(dot({ accuracyM: 120 }));
    expect(h.native.publish).toHaveBeenCalledTimes(1);
    expect(shareNotes(h.notes)).toEqual(["position share on", "position share hold: uncertain", "position share resumed"]);
  });

  test("the driver's held placing is never shared", async () => {
    const h = harness();
    await h.setTrip(true);
    h.setPosition(dot({ source: "manual" }));
    expect(h.native.publish).not.toHaveBeenCalled();
    expect(h.notices.at(-1)).toBe("waiting");
  });

  test("off: nothing starts, and the notification keeps the trip's own words", async () => {
    const h = harness({ enabled: false });
    await h.setTrip(true);
    expect(h.native.start).not.toHaveBeenCalled();
    expect(h.service.getSnapshot().state).toBe("off");
    expect(h.notices.filter((n) => n !== null)).toEqual([]);
  });

  test("not set up: never starts, says what is missing, and the trip notification tells the driver", async () => {
    const h = harness({ setup: { ...READY, mockLocationApp: false } });
    expect(h.service.getSnapshot()).toMatchObject({ state: "setup", setup: { mockLocationApp: false } });
    await h.setTrip(true);
    expect(h.native.start).not.toHaveBeenCalled();
    expect(h.notices.at(-1)).toBe("failed");
    // Set up in Android's settings meanwhile: the next look starts it.
    h.native.setup = READY;
    h.service.recheck();
    await settle();
    expect(h.native.start).toHaveBeenCalledTimes(1);
  });

  test("a refusal is not tried again until the next trip", async () => {
    const h = harness();
    h.native.start.mockRejectedValueOnce(Object.assign(new Error("not allowed"), { code: "start-failed" }));
    await h.setTrip(true);
    expect(h.service.getSnapshot()).toMatchObject({ state: "failed", error: "not allowed" });
    expect(h.notices.at(-1)).toBe("failed");
    h.setPosition(dot());
    expect(h.native.start).toHaveBeenCalledTimes(1);
    expect(h.native.publish).not.toHaveBeenCalled();
    await h.setTrip(false);
    await h.setTrip(true);
    expect(h.native.start).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().state).toBe("holding");
  });

  test("losing the mock location app mid-trip stops sharing and shows what is missing", async () => {
    const h = harness();
    await h.setTrip(true);
    h.setPosition(dot());
    h.native.setup = { ...READY, mockLocationApp: false };
    h.emitError("publish-failed", "not the mock location app");
    await settle();
    expect(h.native.stop).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot()).toMatchObject({ state: "failed", setup: { mockLocationApp: false } });
    expect(h.notes).toContain("position share failed: publish-failed not the mock location app");
  });

  test("the setting turned off mid-trip gives the phone's GPS back and the notification its words", async () => {
    const h = harness();
    await h.setTrip(true);
    h.setPosition(dot());
    await h.setEnabled(false);
    expect(h.native.stop).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().state).toBe("off");
    expect(h.notices.at(-1)).toBeNull();
  });

  test("turned off while starting: stopped as soon as the start is done", async () => {
    const h = harness();
    let finish: () => void = () => undefined;
    h.native.start.mockImplementationOnce(() => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))));
    await h.setTrip(true);
    expect(h.service.getSnapshot().state).toBe("starting");
    await h.setEnabled(false);
    finish();
    await settle();
    expect(h.native.stop).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().state).toBe("off");
  });

  test("the notification is told again until it shows the words (the trip service starts a moment later)", async () => {
    const h = harness();
    h.failNotify(true);
    await h.setTrip(true);
    expect(h.notices.at(-1)).toBe("waiting");
    h.failNotify(false);
    h.setPosition(dot({ source: "manual" }));
    expect(h.notices.slice(-2)).toEqual(["waiting", "waiting"]);
    h.advance(1_000);
    h.setPosition(dot({ source: "manual", lat: 50.46 }));
    expect(h.notices.filter((n) => n === "waiting")).toHaveLength(2);
  });

  test("not set up during a trip: the notification says so once the trip service shows it", async () => {
    const h = harness({ setup: { ...READY, mockLocationApp: false } });
    h.failNotify(true);
    await h.setTrip(true);
    expect(h.notices).toEqual(["failed"]);
    h.failNotify(false);
    h.setPosition(dot());
    expect(h.notices).toEqual(["failed", "failed"]);
    h.setPosition(dot({ lat: 50.46 }));
    expect(h.notices).toHaveLength(2);
  });

  test("verify: the other apps get the fix shared last", async () => {
    const h = harness();
    expect(await h.service.verify()).toBe("none");
    await h.setTrip(true);
    h.setPosition(dot());
    h.native.readBack.mockResolvedValueOnce({ lat: 50.45, lon: 30.52, accuracyM: 18, mock: true, ageMs: 400 });
    expect(await h.service.verify()).toBe("ok");
    h.native.readBack.mockResolvedValueOnce({ lat: 50.5, lon: 30.52, accuracyM: 5, mock: false, ageMs: 400 });
    expect(await h.service.verify()).toBe("other");
  });

  test("Waze's gps provider is wtf.ai's while GPS isn't trusted, the phone's again once it is", async () => {
    const h = harness();
    await h.setTrip(true);
    h.setPosition(dot({ trust: "TRUSTED" }));
    expect(h.native.setGpsTakeover).not.toHaveBeenCalled();
    h.advance(1_000);
    h.setPosition(dot({ trust: "UNTRUSTED" }));
    expect(h.native.setGpsTakeover).toHaveBeenLastCalledWith(true);
    expect(h.service.getSnapshot().gps).toBe("taken");
    // Two minutes on, a probe: given back to look at the real GPS, which is trusted again.
    h.advance(120_000);
    h.setPosition(dot({ trust: "NO_FIX", lat: 50.46 }));
    expect(h.native.setGpsTakeover).toHaveBeenLastCalledWith(false);
    h.advance(5_000);
    h.setPosition(dot({ trust: "TRUSTED", lat: 50.47 }));
    expect(h.service.getSnapshot().gps).toBe("real");
    expect(h.native.setGpsTakeover).toHaveBeenCalledTimes(2);
    expect(h.notes).toEqual(["position share on", "position share gps taken", "position share gps probing", "position share gps real"]);
  });

  test("a probe that meets a spoofed satellite fix takes the gps provider again at the next position", async () => {
    const h = harness();
    await h.setTrip(true);
    const before = { lat: 50.45, lon: 30.52, accuracyM: 5, timestamp: 1 };
    h.setPosition(dot({ trust: "UNTRUSTED", satelliteFix: before }));
    h.advance(120_000);
    h.setPosition(dot({ trust: "UNTRUSTED", lat: 50.46, satelliteFix: before }));
    expect(h.native.setGpsTakeover).toHaveBeenLastCalledWith(false);
    h.advance(1_000);
    // The probe's first fix: the Black Sea, where the spoofer puts the phone.
    h.setPosition(dot({ trust: "UNTRUSTED", lat: 50.47, satelliteFix: { lat: 44, lon: 35, accuracyM: 5, timestamp: 2 } }));
    expect(h.native.setGpsTakeover).toHaveBeenLastCalledWith(true);
    expect(h.service.getSnapshot().gps).toBe("taken");
    expect(h.notes.at(-1)).toMatch(/^position share gps taken: a fix \d+\.\d km off, next probe in 4 min$/);
  });

  test("a failed takeover leaves Waze on the phone's GPS for the trip; Google Maps keeps the shared fixes", async () => {
    const h = harness();
    h.native.setGpsTakeover.mockReturnValueOnce("not allowed");
    await h.setTrip(true);
    h.setPosition(dot());
    expect(h.native.publish).toHaveBeenCalledTimes(1);
    h.advance(1_000);
    h.setPosition(dot({ lat: 50.46 }));
    expect(h.native.setGpsTakeover).toHaveBeenCalledTimes(1);
    expect(h.native.publish).toHaveBeenCalledTimes(2);
    expect(h.notes).toContain("position share gps failed: not allowed");
  });

  test("without the module (iOS, an older build): unavailable", () => {
    const h = harness({ native: false });
    expect(h.service.getSnapshot()).toMatchObject({ state: "unavailable", setup: null });
  });
});
