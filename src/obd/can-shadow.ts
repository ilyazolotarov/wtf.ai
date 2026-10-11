// CAN shadow (docs/VEHICLE-LINK-SPEC.md §16.2): the STN monitor runs between OBD polls while the ECU is awake, and
// its raw frames go to the trip log. Navigation keeps OBD speed. Pure TS: the session starts and stops it.
//
// The STN pass filters also pass broadcast frames into request answers (the MX+ answered `010D1` with a wheel-speed
// frame), so every break pins the speed ECU's receive filter (`ATCRA`) for the polls and opens it for the monitor.

import { CanMonitorCollector, type CanFrame } from "./can-monitor";
import type { Clock } from "./clock";
import type { IdleMonitor, RawSend } from "./elm327/session";
import type { ElmResponse } from "./types";

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
  frames: number;
  windows: number;
  /** Lines dropped: an id not asked for (a line that lost its start). */
  garbled: number;
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
  /** `silent`: the adapter stopped answering altogether while monitoring. */
  onFailed(reason: string, silent: boolean): void;
}

/** The monitor ending by itself this many times: back to plain polling for the session. */
const SELF_ENDS_TO_FAIL = 3;
const SILENT = "no answer at all after stopping the monitor";
/**
 * Listening this long in a row without a frame of the ids: the receive filter (pinned for the polls) didn't open
 * again, and the next way to open it is used (`Reopen`); deaf with the last one too, the shadow is off. On 2026-10-11
 * a bare ATCRA opened it on the MX+ with firmware 5.10.3, but not with 5.13.1, nor on the vLinker (STN1151 v4.3.2):
 * both heard frames only in the first window after each full setup (13 of 13 windows that heard any).
 */
const DEAF_US = 5_000_000;

/**
 * How the receive filter opens again after a break, cheapest first: a bare `ATCRA` (reset); an explicit all-pass
 * `ATCRAXXX`; a full setup (ATAR and the pass filters: 8 commands, ~0.25 s over BLE).
 */
type Reopen = "bare" | "wildcard" | "setup";
/** Stops that found no prompt, this many times: likewise. */
const STOP_FAILURES_TO_FAIL = 3;
/** Commands of others that change what the monitor sees: set up again before the next window. */
const RESETS_SETUP = /^(AT(CRA|CF|CM|SP|TP)|AT(AR|Z|WS|D|H[01])$|ST(?!I$))/;

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");

export class CanShadow implements IdleMonitor {
  private live = false;
  private configured = false;
  /** The receive filter is pinned to the speed ECU (after a stop): open it before the next window. */
  private pinned = false;
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
  private garbled = 0;
  private windowFrames = 0;
  /** Listening since the last frame of the ids, µs. */
  private deafUs = 0;
  private reopen: Reopen = "bare";
  /** The ways whose first answer was logged (what an adapter answers is the diagnosis). */
  private readonly reopenLogged = new Set<Reopen>();
  private readonly wantedIds: Set<number>;

  constructor(private readonly deps: CanShadowDeps) {
    this.wantedIds = new Set(deps.ids);
  }

  get running(): boolean {
    return this.live;
  }

  get status(): CanShadowStatus {
    return {
      state: this.failure ? "failed" : this.live ? "listening" : "waiting",
      frames: this.frames,
      windows: this.windows,
      garbled: this.garbled,
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
      // The monitor obeys the receive filter too.
      while (this.pinned) {
        if (this.reopen === "setup") {
          if (!(await this.setup(send))) return;
          break;
        }
        const command = this.reopenCommand(this.reopen);
        const r = await send(command, 1000);
        if (!this.reopenLogged.has(this.reopen)) {
          this.reopenLogged.add(this.reopen);
          this.deps.onEvent(`reopen: ${command} answered ${JSON.stringify(r.raw.replace(/[\r\n>]+/g, " ").trim())}`);
        }
        if (r.status === "ok") this.pinned = false;
        else if (!this.nextReopen(`${command} refused`)) return;
      }
      // Only the ids asked for: any other is a line that lost its start in transport.
      this.collector = new CanMonitorCollector(this.deps.idDigits, (f) => {
        if (!this.wantedIds.has(f.id)) {
          this.garbled++;
          return;
        }
        this.pending.push(f);
        this.windowFrames++;
      });
      this.windowFrames = 0;
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
      let silent = r.raw === "";
      // A CR reaching an adapter that had just stopped by itself repeats its last command, STM: stop that one too.
      if (r.status === "timeout") {
        r = await send("", 1000);
        silent &&= r.raw === "";
      }
      this.live = false;
      this.collector?.push(r.raw, r.rxUs);
      this.closeWindow(r.txUs, false);
      // Not a byte back, not even the frames still buffered: the adapter froze in the monitor (an OBDLink MX+ twice
      // on 2026-10-11). Polls won't get answers either; the owner recovers the link.
      if (r.status === "timeout" && silent) {
        this.fail(SILENT, true);
        return;
      }
      if (r.status === "timeout" && ++this.stopFailures >= STOP_FAILURES_TO_FAIL) this.fail(`no prompt after stopping the monitor ${this.stopFailures} times`);
      // Broadcast frames would reach the poll's answer through the pass filters.
      if ((await send(`ATCRA${this.pinFilter()}`, 1000)).status === "ok") this.pinned = true;
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

  /** Every session exchange: another component's setup change means setting up again. */
  onExchange(r: ElmResponse): void {
    if (this.own) return;
    if (RESETS_SETUP.test(r.command.replace(/\s+/g, "").toUpperCase())) this.configured = false;
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
    if (this.windows === 0) this.deps.onEvent(`set up: ${ids.length} ids`);
    this.pinned = false;
    this.configured = true;
    return true;
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
    this.frames += this.windowFrames;
    this.windows++;
    this.deps.onWindow({ startUs: this.windowStartUs, endUs, frames: this.windowFrames, endedItself, bufferFull: c.bufferFullCount });
    this.deps.onStatus(this.status);
    if (this.windowFrames > 0) this.deafUs = 0;
    else if ((this.deafUs += endUs - this.windowStartUs) >= DEAF_US) {
      this.deafUs = 0;
      this.nextReopen(`${DEAF_US / 1e6} s of listening heard none of the ids after ${this.reopenName(this.reopen)}`);
    }
  }

  private reopenCommand(way: Exclude<Reopen, "setup">): string {
    return way === "bare" ? "ATCRA" : `ATCRA${this.deps.idDigits === 3 ? "XXX" : "XXXXXXXX"}`;
  }

  private reopenName(way: Reopen): string {
    return way === "setup" ? "a full setup" : this.reopenCommand(way);
  }

  /** The next way to open the filter, from now on; none left: the shadow is off (false). */
  private nextReopen(why: string): boolean {
    const next: Reopen | null = this.reopen === "bare" ? "wildcard" : this.reopen === "wildcard" ? "setup" : null;
    if (!next) {
      this.fail(why);
      return false;
    }
    this.reopen = next;
    this.deps.onEvent(`${why}: the filter opens by ${this.reopenName(next)} from now on`);
    return true;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const frames = this.pending;
    this.pending = [];
    this.deps.onFrames(frames);
  }

  private fail(reason: string, silent = false): void {
    if (this.failure) return;
    this.failure = reason;
    this.deps.onEvent(`off: ${reason}`);
    this.deps.onStatus(this.status);
    this.deps.onFailed(reason, silent);
  }
}
