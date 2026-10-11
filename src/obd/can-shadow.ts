// CAN shadow (docs/VEHICLE-LINK-SPEC.md §16.2): the STN monitor runs between OBD polls while the ECU is awake, and
// its raw frames go to the trip log. Navigation keeps OBD speed. Pure TS: the session starts and stops it.

import { CanMonitorCollector, parseMonitorLine, type CanFrame } from "./can-monitor";
import type { Clock } from "./clock";
import type { IdleMonitor, RawSend } from "./elm327/session";
import type { ElmResponse } from "./types";

/**
 * How polls stay clear of broadcast frames. fast: the pass filters don't reach request answers, a break is stop, poll,
 * restart. safe: they do, so each break pins the speed ECU's receive filter (`ATCRA`) and opens it again after.
 */
export type CanShadowMode = "fast" | "safe";

export interface CanWindow {
  startUs: number;
  endUs: number;
  frames: number;
  /** The adapter stopped monitoring by itself (BUFFER FULL, a reset). */
  endedItself: boolean;
  bufferFull: number;
}

export interface CanShadowStatus {
  state: "waiting" | "listening" | "failed";
  mode: CanShadowMode | null;
  frames: number;
  windows: number;
  failure: string | null;
}

export interface CanShadowDeps {
  clock: Clock;
  writeRaw(text: string): Promise<void>;
  ids: number[];
  /** 3: 11-bit CAN, 8: 29-bit. */
  idDigits: 3 | 8;
  /** The ECU the init pinned for polls; null: functional addressing. */
  pinnedEcu: number | null;
  /** The ECU is awake (engine off or running): the bus has traffic. */
  awake(): boolean;
  onFrames(frames: CanFrame[]): void;
  onWindow(window: CanWindow): void;
  onEvent(detail: string): void;
  onStatus(status: CanShadowStatus): void;
  onFailed(reason: string): void;
}

/** The monitor ending by itself this many times: back to plain polling for the session. */
const SELF_ENDS_TO_FAIL = 3;
/** Stops that found no prompt, this many times: likewise. */
const STOP_FAILURES_TO_FAIL = 3;
/** Polls sent with the pass filters set, to see whether broadcast frames reach their answers. */
const LEAK_PROBES = 3;
/** Commands of others that change what the monitor sees: set up again before the next window. */
const RESETS_SETUP = /^(AT(CRA|CF|CM|SP|TP)|AT(AR|Z|WS|D|H[01])$|ST(?!I$))/;

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");

export class CanShadow implements IdleMonitor {
  private live = false;
  private configured = false;
  private mode: CanShadowMode | null = null;
  private failure: string | null = null;
  private disabled = false;
  /** Inside our own exchanges: they don't reset the setup. */
  private own = false;
  private collector: CanMonitorCollector | null = null;
  private pending: CanFrame[] = [];
  private windowStartUs = 0;
  private frames = 0;
  private windows = 0;
  private selfEnds = 0;
  private stopFailures = 0;

  constructor(private readonly deps: CanShadowDeps) {}

  get running(): boolean {
    return this.live;
  }

  get status(): CanShadowStatus {
    return {
      state: this.failure ? "failed" : this.live ? "listening" : "waiting",
      mode: this.mode,
      frames: this.frames,
      windows: this.windows,
      failure: this.failure,
    };
  }

  wanted(): boolean {
    return !this.disabled && this.failure === null && this.deps.awake();
  }

  /** No new windows; a running one stops before the next command. */
  disable(): void {
    this.disabled = true;
  }

  async start(send: RawSend): Promise<void> {
    this.own = true;
    try {
      if (!this.configured && !(await this.setup(send))) return;
      // safe: the break before pinned the speed ECU's receive filter, which the monitor obeys too.
      if (this.mode === "safe") await send("ATCRA", 1000);
      this.collector = new CanMonitorCollector(this.deps.idDigits, (f) => this.pending.push(f));
      this.windowStartUs = this.deps.clock.nowUs();
      this.live = true;
      await this.deps.writeRaw("STM\r");
      this.deps.onStatus(this.status);
    } catch {
      this.live = false;
    } finally {
      this.own = false;
    }
  }

  async stop(send: RawSend): Promise<void> {
    if (!this.live) return;
    this.own = true;
    try {
      // Any character stops it: the rest of the output, STOPPED, the prompt.
      let r = await send("", 1000);
      // A CR reaching an adapter that had just stopped by itself repeats its last command, STM: stop that one too.
      if (r.status === "timeout") r = await send("", 1000);
      this.live = false;
      this.collector?.push(r.raw, r.rxUs);
      this.closeWindow(r.txUs, false);
      if (r.status === "timeout" && ++this.stopFailures >= STOP_FAILURES_TO_FAIL) this.fail(`no prompt after stopping the monitor ${this.stopFailures} times`);
      if (this.mode === "safe") await send(`ATCRA${this.pinFilter()}`, 1000);
    } finally {
      this.live = false;
      this.own = false;
    }
  }

  /** Monitor output (unsolicited text) while it runs. */
  onText(text: string, rxUs: number): void {
    if (!this.live || !this.collector) return;
    this.collector.push(text, rxUs);
    this.flush();
    if (!text.includes(">")) return;
    // Back at the prompt without being stopped: BUFFER FULL, or the adapter reset.
    this.live = false;
    this.closeWindow(rxUs, true);
    this.selfEnds++;
    if (this.selfEnds >= SELF_ENDS_TO_FAIL) this.fail(`the monitor ended by itself ${this.selfEnds} times`);
    else this.deps.onEvent(`the monitor ended by itself (${this.selfEnds})`);
  }

  /** Every session exchange: another component's setup change, or a poll answer with broadcast frames in it. */
  onExchange(r: ElmResponse): void {
    if (this.own) return;
    const c = r.command.replace(/\s+/g, "").toUpperCase();
    if (RESETS_SETUP.test(c)) this.configured = false;
    if (this.mode === "fast" && /^01[0-9A-F]{2}/.test(c) && this.leak(r.lines)) {
      this.mode = "safe";
      this.deps.onEvent("broadcast frames in a poll answer: the speed ECU's filter is set for each poll from now on");
    }
  }

  private async setup(send: RawSend): Promise<boolean> {
    const { ids, idDigits } = this.deps;
    await send("ATH1", 1000, true);
    // Clears the speed ECU's ATCRA (the CAN hardware filter, which STM obeys) and all custom filters.
    await send("ATAR", 1000, true);
    await send("STCMM0", 1000, true);
    const mask = idDigits === 3 ? "7FF" : "1FFFFFFF";
    for (const id of ids) {
      const f = `${hex(id, idDigits)},${mask}`;
      const added = (await send(`STFPA${f}`, 1000, true)).status === "ok" || (await send(`STFAP${f}`, 1000, true)).status === "ok";
      if (!added) {
        this.fail(`pass filter ${f} refused`);
        return false;
      }
    }
    if (this.mode === null) {
      // Not logged: they aren't speed samples. The event says what was found.
      let leak: string | undefined;
      for (let i = 0; i < LEAK_PROBES && !leak; i++) leak = this.leak((await send("010D1", 1000)).lines);
      this.mode = leak ? "safe" : "fast";
      this.deps.onEvent(
        `${ids.length} ids; ` +
          (leak
            ? `broadcast frames reach poll answers (${leak}): the speed ECU's filter is set for each poll`
            : "poll answers clear of broadcast frames"),
      );
    }
    this.configured = true;
    return true;
  }

  /** The first line that is a CAN frame from something other than an OBD responder (7E8–7EF, 18DAF1xx). */
  private leak(lines: string[]): string | undefined {
    const { idDigits } = this.deps;
    return lines.find((line) => {
      const f = parseMonitorLine(line, idDigits);
      if (!f) return false;
      return idDigits === 3 ? f.id < 0x7e8 || f.id > 0x7ef : (f.id & 0x1fffff00) !== 0x18daf100;
    });
  }

  private pinFilter(): string {
    const { pinnedEcu, idDigits } = this.deps;
    if (pinnedEcu !== null) return hex(pinnedEcu, idDigits);
    return idDigits === 3 ? "7EX" : "18DAF1XX";
  }

  private closeWindow(endUs: number, endedItself: boolean): void {
    const c = this.collector;
    if (!c) return;
    c.end(endUs);
    this.flush();
    this.collector = null;
    this.frames += c.frameCount;
    this.windows++;
    this.deps.onWindow({ startUs: this.windowStartUs, endUs, frames: c.frameCount, endedItself, bufferFull: c.bufferFullCount });
    this.deps.onStatus(this.status);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const frames = this.pending;
    this.pending = [];
    this.deps.onFrames(frames);
  }

  private fail(reason: string): void {
    if (this.failure) return;
    this.failure = reason;
    this.deps.onEvent(`off: ${reason}`);
    this.deps.onStatus(this.status);
    this.deps.onFailed(reason);
  }
}
