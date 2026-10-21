import { isClassicAdapter, runWake, WAKE_WAIT_MS, type WakeDeps, type WakeState } from "@/services/vehicle-wake";

function harness(opts: { state?: WakeState; connect?: () => Promise<void> } = {}) {
  let state: WakeState = opts.state ?? "waiting";
  const listeners = new Set<() => void>();
  const notes: string[] = [];
  const woken: string[] = [];
  let timer: { fn: () => void; ms: number } | null = null;
  const deps: WakeDeps = {
    note: (t) => notes.push(t),
    woken: (how) => woken.push(how),
    connect: opts.connect ?? (async () => {}),
    state: () => state,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    setTimeout: (fn, ms) => (timer = { fn, ms }),
    clearTimeout: () => (timer = null),
  };
  return {
    deps, notes, woken, listeners,
    set: (s: WakeState) => {
      state = s;
      listeners.forEach((l) => l());
    },
    timer: () => timer,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("woken: connects, and waits until a trip records", async () => {
  const h = harness();
  const done = runWake("bluetooth connected", h.deps);
  await flush();
  expect(h.woken).toEqual(["bluetooth connected"]);
  expect(h.timer()?.ms).toBe(WAKE_WAIT_MS);
  h.set("recording");
  await expect(done).resolves.toBe("wake: trip recording");
  expect(h.notes).toEqual(["app woken: bluetooth connected", "wake: trip recording"]);
  expect(h.listeners.size).toBe(0);
  expect(h.timer()).toBeNull();
});

test("nothing to wait for: the task ends at once, saying why", async () => {
  const h = harness({ state: { gone: "no adapter remembered" } });
  await expect(runWake("ble in range", h.deps)).resolves.toBe("wake: no adapter remembered");
});

test("no adapter yet while the connect gets ready: not taken for nothing to wait for", async () => {
  let connected!: () => void;
  const h = harness({ state: { gone: "no adapter remembered" }, connect: () => new Promise<void>((r) => (connected = r)) });
  const done = runWake("ble in range", h.deps);
  await flush();
  h.set({ gone: "no adapter remembered" });
  h.set("waiting");
  connected();
  await flush();
  h.set("recording");
  await expect(done).resolves.toBe("wake: trip recording");
});

test("a connect that never returns (the adapter out of range): the wait still ends", async () => {
  const h = harness({ connect: () => new Promise<void>(() => {}) });
  const done = runWake("location", h.deps);
  await flush();
  expect(h.timer()?.ms).toBe(WAKE_WAIT_MS);
  h.timer()!.fn();
  await expect(done).resolves.toBe("wake: no trip in 9 min");
});

test("no trip in time: the task ends, so the CPU can sleep", async () => {
  const h = harness();
  const done = runWake("ble in range", h.deps);
  await flush();
  h.timer()!.fn();
  await expect(done).resolves.toBe("wake: no trip in 9 min");
  expect(h.listeners.size).toBe(0);
});

test("a failed connect is noted and ends the task", async () => {
  const h = harness({ connect: async () => Promise.reject(new Error("bluetooth-off")) });
  await expect(runWake("ble in range", h.deps)).resolves.toBe("wake: connect failed (bluetooth-off)");
});

test("a Classic OBD adapter picked in the dialog is recognised, the car's own Bluetooth is not", () => {
  const ids = ["spp:00:1D:A5:68:98:8A", "AA:BB:CC:DD:EE:FF", "emulator:can"];
  expect(isClassicAdapter("00:1d:a5:68:98:8a", ids)).toBe(true);
  expect(isClassicAdapter("AA:BB:CC:DD:EE:FF", ids)).toBe(false);
  expect(isClassicAdapter("11:22:33:44:55:66", ids)).toBe(false);
});
