// What the app does when Android wakes it for a companion device (docs/VEHICLE-LINK-SPEC.md §11): connect the
// remembered adapter, and stay up until a trip records (the trip service then holds the process) or there is nothing
// to wait for. The native side gives the task 10 min and holds the CPU while it runs.

export const WAKE_TASK = "VehicleWake";

/** Under the native task timeout (WakeLogic.TASK_TIMEOUT_MS), so the task ends on its own terms. */
export const WAKE_WAIT_MS = 9 * 60_000;

/** `gone`: nothing to wait for, and why (the trip log's words). */
export type WakeState = "recording" | "waiting" | { gone: string };

export interface WakeDeps {
  note(text: string): void;
  /** For the launch note: what started this process, if it was this. */
  woken(how: string): void;
  connect(): Promise<void>;
  /** "recording": the trip service holds the process now; `gone`: no adapter, no permission, or the link failed. */
  state(): WakeState;
  subscribe(listener: () => void): () => void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Resolves with how the wait ended (also noted). The wait counts from the wake, not from the connect: a connect that
 * waits for the adapter to come into range may never return.
 */
export async function runWake(how: string, deps: WakeDeps): Promise<string> {
  deps.woken(how);
  deps.note(`app woken: ${how}`);
  const outcome = await new Promise<string>((resolve) => {
    let done = false;
    // Until the connect has returned, no adapter yet is the connect getting ready, not nothing to wait for.
    let connected = false;
    let timer: unknown = null;
    let off: (() => void) | null = null;
    const end = (text: string) => {
      if (done) return;
      done = true;
      off?.();
      if (timer !== null) deps.clearTimeout(timer);
      resolve(text);
    };
    const check = () => {
      const state = deps.state();
      if (state === "recording") end("wake: trip recording");
      else if (connected && state !== "waiting") end(`wake: ${state.gone}`);
    };
    off = deps.subscribe(check);
    timer = deps.setTimeout(() => end(`wake: no trip in ${WAKE_WAIT_MS / 60_000} min`), WAKE_WAIT_MS);
    deps.connect().then(
      () => {
        connected = true;
        check();
      },
      (error: unknown) => end(`wake: connect failed (${error instanceof Error ? error.message : String(error)})`),
    );
  });
  deps.note(outcome);
  return outcome;
}

/**
 * The device picked in Android's dialog is a Bluetooth Classic OBD adapter (`spp:<MAC>` among `deviceIds`): it never
 * connects by itself, so Android never sees it appear and it would never start the app.
 */
export function isClassicAdapter(address: string, deviceIds: readonly string[]): boolean {
  const mac = address.toUpperCase();
  return deviceIds.some((id) => id.startsWith("spp:") && id.slice(4).toUpperCase() === mac);
}
