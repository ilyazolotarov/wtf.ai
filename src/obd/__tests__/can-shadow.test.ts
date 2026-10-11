import type { CanFrame } from "@/obd/can-monitor";
import { CanShadow, type CanWindow } from "@/obd/can-shadow";
import { VirtualClock } from "@/obd/clock";
import type { RawSend } from "@/obd/elm327/session";

function shadow() {
  const frames: CanFrame[] = [];
  const windows: CanWindow[] = [];
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
  return { s, send, frames, windows };
}

describe("CanShadow", () => {
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

  test("the monitor ending by itself closes the window; three times turns the shadow off", async () => {
    const { s, send, windows } = shadow();
    for (let i = 0; i < 3; i++) {
      await s.start(send);
      s.onText("2152710271027102710\rBUFFER FULL\r\r>", 100);
      expect(s.running).toBe(false);
    }
    expect(windows.every((w) => w.endedItself && w.bufferFull === 1)).toBe(true);
    expect(s.status.state).toBe("failed");
    expect(s.wanted()).toBe(false);
  });
});
