// The speed and camera warnings every screen shares (speed-alerts.ts, UI-SPEC §6.4, §6.5): one red state, one chime,
// one "Speed camera ahead" per camera, however many screens follow them.

import { en } from "@/i18n/en";
import type { PositionEstimate } from "@/nav/position/types";
import type { CameraAhead } from "@/nav/speed/camera-alert";
import type { SpeedPreferences } from "@/services/speed-preferences";

import { cameraWords, SAY_AGAIN_MS, speedBesideCard, SpeedAlerts } from "../speed-alerts";

function setup(prefs: Partial<SpeedPreferences> = {}) {
  let position: PositionEstimate | null = null;
  let preferences: SpeedPreferences = { showLimit: true, cameras: true, marginKph: 15, ...prefs };
  let silent = false;
  let wall = 1_000_000;
  const positionListeners = new Set<() => void>();
  const prefListeners = new Set<() => void>();
  const notes: string[] = [];
  const chimes: number[] = [];
  const said: boolean[] = [];
  let chimeFails = false;
  const alerts = new SpeedAlerts({
    position: {
      getSnapshot: () => position,
      subscribe: (l) => {
        positionListeners.add(l);
        return () => positionListeners.delete(l);
      },
    },
    preferences: {
      getSnapshot: () => preferences,
      subscribe: (l) => {
        prefListeners.add(l);
        return () => prefListeners.delete(l);
      },
    },
    silent: () => silent,
    note: (text) => notes.push(text),
    chime: () => {
      if (chimeFails) throw new Error("no player");
      chimes.push(wall);
    },
    sayCamera: (slowDown) => said.push(slowDown),
    nowMs: () => wall,
  });
  let t = 0;
  /** A position a second after the last (`dtMs`), at `kph`, with the road's limit and the camera ahead. */
  const drive = (kph: number, limitKph?: number, cameraAhead?: CameraAhead, dtMs = 1000) => {
    t += dtMs;
    wall += dtMs;
    position = {
      lat: 50.45,
      lon: 30.52,
      accuracyM: 5,
      headingRad: 0,
      speedMps: kph / 3.6,
      source: "fused",
      trust: "TRUSTED",
      timestamp: t,
      ...(limitKph !== undefined ? { speedLimit: { kph: limitKph, tagged: true } } : {}),
      ...(cameraAhead ? { cameraAhead } : {}),
    } as PositionEstimate;
    positionListeners.forEach((l) => l());
  };
  return {
    alerts,
    drive,
    notes,
    chimes,
    said,
    setSilent: (v: boolean) => (silent = v),
    failChime: () => (chimeFails = true),
    setPreferences: (change: Partial<SpeedPreferences>) => {
      preferences = { ...preferences, ...change };
      prefListeners.forEach((l) => l());
    },
    listeners: () => positionListeners.size + prefListeners.size,
  };
}

const camera = (id: number, distanceM: number, limitKph?: number): CameraAhead => ({
  id,
  lat: 50.46,
  lon: 30.52,
  distanceM,
  fromM: 600,
  listed: false,
  ...(limitKph !== undefined ? { limitKph } : {}),
});

describe("speed alerts", () => {
  test("followed only while a screen retains them; two screens, one subscription", () => {
    const s = setup();
    expect(s.listeners()).toBe(0);
    const phone = s.alerts.retain();
    const car = s.alerts.retain();
    expect(s.listeners()).toBe(2);
    phone();
    phone();
    expect(s.listeners()).toBe(2);
    car();
    expect(s.listeners()).toBe(0);
  });

  test("too fast past the margin for 1.5 s: red and one chime, until 3 km/h back under", () => {
    const s = setup();
    s.alerts.retain();
    s.drive(64, 50);
    expect(s.alerts.getSnapshot().speed).toEqual({ speedKph: 64, limitKph: 50, over: false });
    s.drive(70, 50);
    expect(s.alerts.getSnapshot().speed.over).toBe(false);
    s.drive(70, 50, undefined, 1500);
    expect(s.alerts.getSnapshot().speed.over).toBe(true);
    expect(s.chimes).toHaveLength(1);
    expect(s.notes).toEqual(["speed warning: 70 km/h, limit 50 + 15"]);
    s.drive(64, 50);
    expect(s.alerts.getSnapshot().speed.over).toBe(true);
    s.drive(62, 50);
    expect(s.alerts.getSnapshot().speed.over).toBe(false);
    expect(s.chimes).toHaveLength(1);
  });

  test("the voice muted or at 0: noted as silent, no chime", () => {
    const s = setup();
    s.alerts.retain();
    s.setSilent(true);
    s.drive(70, 50);
    s.drive(70, 50, undefined, 1500);
    expect(s.chimes).toEqual([]);
    expect(s.notes).toEqual(["speed warning: 70 km/h, limit 50 + 15 (silent)"]);
  });

  test("the same position again (another listener's notice) changes nothing: the snapshot stays the same object", () => {
    const s = setup();
    s.alerts.retain();
    s.drive(40, 50, camera(3, 500, 50));
    const before = s.alerts.getSnapshot();
    s.setPreferences({});
    expect(s.alerts.getSnapshot()).toBe(before);
  });

  test("a camera: said once when it shows, again only after 2 min; its card red past the margin, by the warning's rules", () => {
    const s = setup();
    s.alerts.retain();
    s.drive(60, 50, camera(3, 500, 50));
    expect(s.said).toEqual([false]);
    expect(s.alerts.getSnapshot().camera).toEqual({ id: 3, distanceM: 500, progress: 1 - 500 / 600, limitKph: 50, slowDown: false });
    s.drive(70, 50, camera(3, 480, 50));
    s.drive(70, 50, camera(3, 460, 50), 1500);
    expect(s.alerts.getSnapshot().camera?.slowDown).toBe(true);
    expect(s.notes).toEqual([
      "camera warning #3: 60 km/h, limit 50 + 15",
      // The road's limit there too: the speed's own warning.
      "speed warning: 70 km/h, limit 50 + 15",
      "camera slow down #3: 70 km/h, limit 50 + 15",
    ]);
    // Lost for a moment and found: not news.
    s.drive(70, 50);
    s.drive(70, 50, camera(3, 300, 50));
    expect(s.said).toEqual([false]);
    s.drive(70, 50, undefined, SAY_AGAIN_MS);
    s.drive(70, 50, camera(3, 300, 50));
    expect(s.said).toEqual([false, true]);
  });

  test("a red card blinking out of sight comes back red at once, its slow down noted once", () => {
    const s = setup();
    s.alerts.retain();
    s.drive(70, undefined, camera(5, 500, 50));
    s.drive(70, undefined, camera(5, 480, 50), 1500);
    expect(s.alerts.getSnapshot().camera?.slowDown).toBe(true);
    s.drive(70, undefined);
    expect(s.alerts.getSnapshot().camera).toBeNull();
    s.drive(70, undefined, camera(5, 440, 50));
    expect(s.alerts.getSnapshot().camera?.slowDown).toBe(true);
    expect(s.notes.filter((n) => n.startsWith("camera slow down"))).toHaveLength(1);
    // Another camera starts its own warning.
    s.drive(70, undefined, camera(6, 600, 50));
    expect(s.alerts.getSnapshot().camera?.slowDown).toBe(false);
  });

  test("a voice that throws doesn't throw into the navigator's publish; the snapshot still moves on", () => {
    const s = setup();
    s.alerts.retain();
    s.failChime();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    s.drive(70, 50);
    expect(() => s.drive(70, 50, undefined, 1500)).not.toThrow();
    expect(s.alerts.getSnapshot().speed.over).toBe(true);
    expect(warn).toHaveBeenCalledWith("speed alerts: no player");
    warn.mockRestore();
  });

  test("beside a card with a sign, the speed has none and is red past the lower limit, the road's or the camera's", () => {
    const card = { id: 1, distanceM: 300, progress: 0.5, limitKph: 50, slowDown: true };
    // A 50 camera on a road tagged 110: red for the camera.
    expect(speedBesideCard({ speedKph: 72, limitKph: 110, over: false }, card)).toEqual({ speedKph: 72, limitKph: undefined, over: true });
    // A 70 camera on a road tagged 50 (a tagging error): the road's red isn't hidden.
    expect(speedBesideCard({ speedKph: 66, limitKph: 50, over: true }, { ...card, limitKph: 70, slowDown: false }).over).toBe(true);
    expect(speedBesideCard({ speedKph: 60, limitKph: 50, over: false }, { ...card, slowDown: false }).over).toBe(false);
    // A card without a sign, or none: the road's.
    const road = { speedKph: 66, limitKph: 50, over: true };
    expect(speedBesideCard(road, { ...card, limitKph: undefined })).toBe(road);
    expect(speedBesideCard(road, null)).toBe(road);
  });

  test("a camera without a limit is never red; with the warnings off, none", () => {
    const s = setup();
    s.alerts.retain();
    s.drive(120, undefined, camera(4, 500));
    s.drive(120, undefined, camera(4, 450), 2000);
    expect(s.alerts.getSnapshot().camera).toMatchObject({ id: 4, slowDown: false });
    expect(s.alerts.getSnapshot().camera?.limitKph).toBeUndefined();
    s.setPreferences({ cameras: false });
    expect(s.alerts.getSnapshot().camera).toBeNull();
  });

  test("the card's words: the distance in steps; red, Slow down over it", () => {
    const t = (key: keyof typeof en) => en[key];
    const plain = cameraWords({ id: 1, distanceM: 437, progress: 0.3, limitKph: 50, slowDown: false }, t, "en");
    expect(plain.title).toMatch(/^Speed camera in 450\sm$/);
    expect(plain.line).toBeNull();
    const red = cameraWords({ id: 1, distanceM: 137, progress: 0.8, limitKph: 50, slowDown: true }, t, "en");
    expect(red).toEqual({ title: "Slow down", line: expect.stringMatching(/^Speed camera in 140\sm$/), red: true });
  });
});
