import type { CanFrame } from "@/obd/can-monitor";
import { CanShadow, type CanWindow } from "@/obd/can-shadow";
import { VirtualClock } from "@/obd/clock";
import type { RawSend } from "@/obd/elm327/session";

function shadow() {
  const frames: CanFrame[] = [];
  const windows: CanWindow[] = [];
  const bufferFull: CanWindow[] = [];
  const s = new CanShadow({
    clock: new VirtualClock(),
    writeRaw: async () => undefined,
    ids: [0x215, 0x228],
    idDigits: 3,
    pinnedEcu: 0x7e8,
    awake: () => true,
    onFrames: (f) => frames.push(...f),
    onWindow: (w) => windows.push(w),
    onEvent: () => undefined,
    onStatus: () => undefined,
    onFailed: () => undefined,
    onBufferFull: (w) => bufferFull.push(w),
    selfTest: false,
  });
  // OK to every setup command; the stop gets the prompt.
  const send: RawSend = async (command) => ({
    command,
    status: "ok",
    lines: command.startsWith("01") ? ["7E803410D00"] : ["OK"],
    raw: command === "" ? "STOPPED\r\r>" : "OK\r\r>",
    txUs: 0,
    rxUs: 0,
  });
  return { s, send, frames, windows, bufferFull };
}

describe("CanShadow", () => {
  test("a window carries its bytes, the frames of other ids, how its stop went and how the filter was opened", async () => {
    const clock = new VirtualClock();
    const frames: CanFrame[] = [];
    const windows: CanWindow[] = [];
    const events: string[] = [];
    const s = new CanShadow({
      clock,
      writeRaw: async () => undefined,
      ids: [0x215],
      idDigits: 3,
      pinnedEcu: 0x7e8,
      awake: () => true,
      onFrames: (f) => frames.push(...f),
      onWindow: (w) => windows.push(w),
      onEvent: (e) => events.push(e),
      onStatus: () => undefined,
      onFailed: () => undefined,
      selfTest: false,
    });
    let stops = 0;
    // The first stop character gets no prompt (the adapter still draining, 2026-10-11 on the vLinker); the second does.
    const send: RawSend = async (command) => {
      const txUs = clock.nowUs();
      if (command === "" && stops++ === 0) {
        await clock.sleep(1000);
        return { command, status: "timeout", lines: [], raw: "", txUs, rxUs: clock.nowUs() };
      }
      await clock.sleep(30);
      const raw = command === "" ? "2152710271027102710\rSTOPPED\r\r>" : "OK\r\r>";
      return { command, status: "ok", lines: [], raw, txUs, rxUs: clock.nowUs() };
    };
    await s.start(send);
    s.onText("2152710271027102710\r2280120\r", clock.nowUs());
    await s.stop(send);
    expect(frames.map((f) => f.id)).toEqual([0x215, 0x215]);
    expect(windows).toHaveLength(1);
    // 28 bytes of monitor output, 30 in the stop's answer.
    expect(windows[0]).toMatchObject({ frames: 2, other: 1, bytes: 58, stopRetried: true, reopen: "open" });
    expect(windows[0].stopMs).toBeGreaterThanOrEqual(1030);
    // The second window: the filter was opened by a bare ATCRA.
    await s.start(send);
    await s.stop(send);
    expect(windows[1]).toMatchObject({ frames: 1, stopRetried: false, reopen: "bare" });
    expect(windows[1].stopMs).toBe(30);
    // A retried stop that got its prompt is the window's `stopRetried`, not a wrong answer.
    expect(events.some((e) => e.startsWith("stop: no prompt"))).toBe(false);
  });

  test("a silent stop says what the window was", async () => {
    const clock = new VirtualClock();
    const windows: CanWindow[] = [];
    const events: string[] = [];
    const s = new CanShadow({
      clock,
      writeRaw: async () => undefined,
      ids: [0x215],
      idDigits: 3,
      pinnedEcu: 0x7e8,
      awake: () => true,
      onFrames: () => undefined,
      onWindow: (w) => windows.push(w),
      onEvent: (e) => events.push(e),
      onStatus: () => undefined,
      onFailed: () => undefined,
      selfTest: false,
    });
    const silent: RawSend = async (command) => {
      const txUs = clock.nowUs();
      if (command === "") {
        await clock.sleep(1000);
        return { command, status: "timeout", lines: [], raw: "", txUs, rxUs: clock.nowUs() };
      }
      return { command, status: "ok", lines: [], raw: "OK\r\r>", txUs, rxUs: clock.nowUs() };
    };
    await s.start(silent);
    await clock.sleep(300);
    s.onText("2152710271027102710\r", clock.nowUs());
    await clock.sleep(150);
    await s.stop(silent);
    expect(windows[0]).toMatchObject({ frames: 1, stopMs: null, stopRetried: true });
    // The window ends with the first stop character; the 1 s without a prompt is not listening.
    expect(windows[0].endUs - windows[0].startUs).toBe(450_000);
    expect(events.find((e) => e.startsWith("off: no answer at all"))).toMatch(/\(window 450 ms, 1 frames, 20 bytes, last output 150 ms before the stop\)/);
    expect(s.status.state).toBe("failed");
  });

  test("drops lines with an id it didn't ask for (a line that lost its start), and counts them", async () => {
    const { s, send, frames, windows } = shadow();
    await s.start(send);
    expect(s.running).toBe(true);
    s.onText("2152710271027102710\r71027102710\r2280120\r", 100);
    await s.stop(send);
    expect(frames.map((f) => f.id)).toEqual([0x215, 0x228]);
    expect(windows).toEqual([expect.objectContaining({ frames: 2, endedItself: false })]);
    expect(s.status).toMatchObject({ frames: 2, windows: 1, garbled: 1 });
  });

  test("the monitor ending by itself (not BUFFER FULL) closes the window; three times turns the shadow off", async () => {
    const { s, send, windows } = shadow();
    for (let i = 0; i < 3; i++) {
      await s.start(send);
      // The adapter reset under the monitor: its banner and a prompt.
      s.onText("2152710271027102710\r\rELM327 v1.4b\r\r>", 100);
      expect(s.status.state).toBe(i < 2 ? "waiting" : "failed");
      // Still "running" for the session: the filter is open and needs pinning before the next poll.
      expect(s.running).toBe(true);
      await s.stop(send);
      expect(s.running).toBe(false);
    }
    expect(windows.every((w) => w.endedItself && w.bufferFull === 0)).toBe(true);
    expect(s.status.state).toBe("failed");
    expect(s.wanted()).toBe(false);
  });

  // 2026-10-13, CAN primary: five ids without the polls' breaks outran the MX+'s link three times a drive, and the
  // shadow went off as the car drove off.
  test("BUFFER FULL is the link's capacity, not the adapter failing: the owner hears of it, the shadow stays on", async () => {
    const { s, send, windows, bufferFull } = shadow();
    for (let i = 0; i < 5; i++) {
      await s.start(send);
      s.onText("2152710271027102710\rBUFFER FULL\r\r>", 100);
      expect(s.status.state).toBe("waiting");
      await s.stop(send);
    }
    expect(windows.every((w) => w.endedItself && w.bufferFull === 1)).toBe(true);
    expect(bufferFull).toHaveLength(5);
    expect(s.wanted()).toBe(true);
  });

  test("a window that ended by itself leaves the filter open: the next stop only pins it, then listening resumes", async () => {
    const { s, windows } = shadow();
    const sent: string[] = [];
    const send: RawSend = async (command) => {
      sent.push(command);
      return { command, status: "ok", lines: ["OK"], raw: command === "" ? "STOPPED\r\r>" : "OK\r\r>", txUs: 0, rxUs: 0 };
    };
    await s.start(send);
    s.onText("2152710271027102710\rBUFFER FULL\r\r>", 100);
    expect(windows).toEqual([expect.objectContaining({ endedItself: true })]);
    const n = sent.length;
    // The session's next command: no stop character (nothing runs), the pin for the poll, no second window closed.
    await s.stop(send);
    expect(sent.slice(n)).toEqual(["ATCRA7E8"]);
    expect(windows).toHaveLength(1);
    expect(s.running).toBe(false);
    // The next window opens the filter again, as after a normal stop.
    const m = sent.length;
    await s.start(send);
    expect(sent.slice(m)).toEqual(["ATCRA"]);
    expect(s.running).toBe(true);
    await s.stop(send);
    expect(windows).toHaveLength(2);
  });
});
