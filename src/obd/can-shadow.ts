// CAN shadow (docs/VEHICLE-LINK-SPEC.md §16.2): the STN monitor runs between OBD polls while the ECU is awake, and
// its raw frames go to the trip log. Navigation keeps OBD speed. Pure TS: the session starts and stops it.
//
// The STN pass filters also pass broadcast frames into request answers (the MX+ answered `010D1` with a wheel-speed
// frame), so every break pins the speed ECU's receive filter (`ATCRA`) for the polls and opens it for the monitor.

import { CanMonitorCollector, type CanFrame } from "./can-monitor";
import type { Clock } from "./clock";
import type { IdleMonitor, RawSend } from "./elm327/session";
import type { ElmResponse } from "./types";

/** How the receive filter was opened for a window: not needed (the setup left it open), or one of the ways. */
export type CanReopen = "open" | "bare" | "wildcard" | "setup";

export interface CanWindow {
  startUs: number;
  endUs: number;
  frames: number;
  /** The adapter stopped monitoring by itself (BUFFER FULL, a reset). */
  endedItself: boolean;
  bufferFull: number;
  /** Monitor output received, bytes: the link's throughput. */
  bytes: number;
  /** Frames with an id not asked for: the filter wide open, or lines that lost their start in transport. */
  other: number;
  /** Our stop: from the stop character to the prompt, ms; null when the window ended by itself or no prompt came. */
  stopMs: number | null;
  /** The first stop character got no prompt within its timeout; a second one did (or didn't either). */
  stopRetried: boolean;
  reopen: CanReopen;
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
  /** The filter self-test at the first setup (default on; off in unit tests that script the answers). */
  selfTest?: boolean;
}

/** The monitor ending by itself this many times: back to plain polling for the session. */
const SELF_ENDS_TO_FAIL = 3;
const SILENT = "no answer at all after stopping the monitor";
/**
 * Listening this long in a row without a frame of the ids: the receive filter (pinned for the polls) didn't open
 * again, and the next way to open it is used (`Reopen`); deaf with the last one too, the shadow is off. A backstop:
 * the self-test (`filterTest`) measures the ways at setup.
 */
const DEAF_US = 5_000_000;

/**
 * How the receive filter opens again after a break, cheapest first: a bare `ATCRA` (the manual: back to the
 * protocol's default filter, which opened it only on MX+ firmware before 5.12.4); an explicit all-pass `ATCRAXXX`;
 * a full setup (ATAR and the pass filters: 8 commands, ~0.25 s over BLE). ATAR alone also clears the pass filters.
 */
type Reopen = "bare" | "wildcard" | "setup";
const REOPENS: readonly Reopen[] = ["bare", "wildcard", "setup"];
/** Stops that found no prompt, this many times: likewise. */
const STOP_FAILURES_TO_FAIL = 3;
/** Commands of others that change what the monitor sees: set up again before the next window. */
const RESETS_SETUP = /^(AT(CRA|CF|CM|SP|TP)|AT(AR|Z|WS|D|H[01])$|ST(?!I$))/;
/** The self-test listens this long per way. */
const TEST_LISTEN_MS = 250;
/** A way counts as opening the filter when it heard at least this share of what the setup's open filter heard. */
const TEST_MIN_SHARE = 0.3;
/** With nothing heard even after the setup (a silent bus), the test is tried again after this long. */
const TEST_RETRY_US = 60_000_000;
/** Own exchanges into the transcript: the first few of each kind (what each adapter answers is the diagnosis). */
const LOG_FIRST = 3;
/** Answers that went wrong go to the link events, up to this many. */
const WRONG_MAX = 30;

const hex = (n: number, digits: number) => n.toString(16).toUpperCase().padStart(digits, "0");
const quote = (raw: string) => JSON.stringify(raw.replace(/[\r\n>]+/g, " ").trim());
/** A monitor line: a CAN id (3 or 8 hex digits) and data bytes. */
const FRAME_LINE = /^[0-9A-F]{3}([0-9A-F]{5})?([0-9A-F]{2}){0,8}$/i;

export class CanShadow implements IdleMonitor {
  private live = false;
  private configured = false;
  /** The receive filter is pinned to the speed ECU (after a stop): open it before the next window. */
  private pinned = false;
  /**
   * The window ended by itself with the filter open: pin it before the next poll (`stop()` does, as after every
   * window; the session calls it while `running`).
   */
  private pinDue = false;
  private failure: string | null = null;
  private disabled = false;
  /** Inside our own exchanges: they don't reset the setup. */
  private own = false;
  private collector: CanMonitorCollector | null = null;
  /** The self-test listens: text is counted, nothing else. */
  private probing = false;
  private pending: CanFrame[] = [];
  private windowStartUs = 0;
  private frames = 0;
  private windows = 0;
  private selfEnds = 0;
  private stopFailures = 0;
  private garbled = 0;
  private windowFrames = 0;
  private windowBytes = 0;
  private windowOther = 0;
  private windowReopen: CanReopen = "open";
  /** The last monitor output, µs. */
  private lastTextUs = -Infinity;
  /** Listening since the last frame of the ids, µs. */
  private deafUs = 0;
  private reopen: Reopen = "bare";
  private testedUs: number | null = null;
  private retestLater = false;
  private readonly logCounts = new Map<string, number>();
  private wrongLogged = 0;
  private readonly wantedIds: Set<number>;

  constructor(private readonly deps: CanShadowDeps) {
    this.wantedIds = new Set(deps.ids);
  }

  /** The session must stop (or pin after) the monitor before its next command. */
  get running(): boolean {
    return this.live || this.pinDue;
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
      if (!this.configured && !(await this.setup(send, true))) return;
      if (this.deps.selfTest !== false && this.testedUs === null) {
        this.testedUs = this.deps.clock.nowUs();
        if (!(await this.filterTest(send))) return;
      }
      // The monitor obeys the receive filter too.
      let reopened: CanReopen = "open";
      while (this.pinned) {
        if (this.reopen === "setup") {
          if (!(await this.setup(send))) return;
          reopened = "setup";
          break;
        }
        const command = this.reopenCommand(this.reopen);
        const r = await send(command, 1000, this.logs(this.reopen));
        if (r.status === "ok") {
          this.pinned = false;
          reopened = this.reopen;
        } else {
          this.wrong(`${command} answered ${quote(r.raw)}`);
          if (!this.nextReopen(`${command} refused`)) return;
        }
      }
      this.openWindow(reopened);
      await this.deps.writeRaw("STM\r");
      this.deps.onStatus(this.status);
    } catch {
      this.live = false;
    } finally {
      this.own = false;
    }
  }

  async stop(send: RawSend): Promise<void> {
    if (!this.live) {
      if (this.pinDue) await this.pinAfterSelfEnd(send);
      return;
    }
    this.own = true;
    try {
      // Any character stops it: the rest of the output, STOPPED, the prompt.
      const t0 = this.deps.clock.nowUs();
      let r = await send("", 1000, this.logs("stop"));
      let silent = r.raw === "";
      const retried = r.status === "timeout";
      // A CR reaching an adapter that had just stopped by itself repeats its last command, STM: stop that one too.
      if (retried) {
        // What the first one drained is the window's output too.
        this.collector?.push(r.raw, r.rxUs);
        this.windowBytes += r.raw.length;
        r = await send("", 1000, true);
        silent &&= r.raw === "";
      }
      this.live = false;
      this.collector?.push(r.raw, r.rxUs);
      this.windowBytes += r.raw.length;
      const stopMs = r.status !== "timeout" ? Math.round((r.rxUs - t0) / 1000) : null;
      const lastOutputMs = Math.round((t0 - Math.max(this.lastTextUs, this.windowStartUs)) / 1000);
      // Listening ended with the first stop character; what came after it is the drain (`stopMs`).
      const w = this.closeWindow(t0, false, stopMs, retried);
      // Not a byte back, not even the frames still buffered: the adapter froze in the monitor (an OBDLink MX+ twice
      // on 2026-10-11). Polls won't get answers either; the owner recovers the link.
      if (r.status === "timeout" && silent) {
        this.fail(
          `${SILENT} (window ${Math.round((w.endUs - w.startUs) / 1000)} ms, ${w.frames} frames, ${w.bytes} bytes, last output ${lastOutputMs} ms before the stop)`,
          true,
        );
        return;
      }
      if (r.status === "timeout") {
        this.wrong(`stop: no prompt, ${quote(r.raw)}`);
        if (++this.stopFailures >= STOP_FAILURES_TO_FAIL) this.fail(`no prompt after stopping the monitor ${this.stopFailures} times`);
      }
      await this.pin(send);
    } finally {
      this.live = false;
      this.own = false;
    }
  }

  /** Broadcast frames would reach the poll's answer through the pass filters: pin the speed ECU's filter. */
  private async pin(send: RawSend): Promise<void> {
    const pin = await send(`ATCRA${this.pinFilter()}`, 1000, this.logs("pin"));
    this.pinDue = false;
    if (pin.status === "ok") this.pinned = true;
    else this.wrong(`ATCRA${this.pinFilter()} answered ${quote(pin.raw)}`);
  }

  /** The adapter stopped by itself and is at its prompt with the filter open: pin it, nothing to stop. */
  private async pinAfterSelfEnd(send: RawSend): Promise<void> {
    this.own = true;
    try {
      await this.pin(send);
    } catch {
      this.pinDue = false;
    } finally {
      this.own = false;
    }
  }

  /** Monitor output (unsolicited text) while it runs. */
  onText(text: string, rxUs: number): void {
    if (!this.live || !this.collector) return;
    this.lastTextUs = rxUs;
    if (this.probing) {
      this.collector.push(text, rxUs);
      return;
    }
    this.windowBytes += text.length;
    this.collector.push(text, rxUs);
    this.flush();
    if (!text.includes(">")) return;
    // Back at the prompt without being stopped: BUFFER FULL, or the adapter reset. The filter is still open: the
    // next command (a poll) first has `stop()` pin it.
    this.live = false;
    this.pinDue = true;
    this.closeWindow(rxUs, true, null, false);
    this.selfEnds++;
    if (this.selfEnds >= SELF_ENDS_TO_FAIL) this.fail(`the monitor ended by itself ${this.selfEnds} times`);
    else this.deps.onEvent(`the monitor ended by itself (${this.selfEnds}): ${quote(text.slice(-60))}`);
  }

  /** Every session exchange: another component's setup change means setting up again. */
  onExchange(r: ElmResponse): void {
    if (this.own) return;
    if (RESETS_SETUP.test(r.command.replace(/\s+/g, "").toUpperCase())) this.configured = false;
  }

  /** `withStatus`: also the CAN error counters (ATCS), into the transcript: a first setup, not a reopen. */
  private async setup(send: RawSend, withStatus = false): Promise<boolean> {
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
    if (withStatus) await send("ATCS", 1000, true);
    if (this.windows === 0) this.deps.onEvent(`set up: ${ids.length} ids`);
    this.pinned = false;
    this.configured = true;
    return true;
  }

  /**
   * Once per session, after the first setup: which way opens the receive filter after a break, measured rather
   * than assumed. 2026-10-11: a bare ATCRA opened it on the MX+ with firmware 5.10.3 only (the manual: it restores
   * the protocol's default filter, 5.12.4 made it do so), not with 5.13.1 nor on the vLinker, which were deaf after
   * their first break. Listens TEST_LISTEN_MS after: the setup (the filter as ATAR left it); the pin alone (must hear
   * nothing: STM obeys it); each way after a pin. Picks the cheapest way that heard enough. Also whether `STM n`
   * (a window ending by itself after n frames, MX+ firmware 5.12.4+) is accepted. One line with it all into the log.
   */
  private async filterTest(send: RawSend): Promise<boolean> {
    const parts: string[] = [];
    const pin = () => send(`ATCRA${this.pinFilter()}`, 1000, true);
    const heard: Record<"open" | "pinned" | Reopen, number> = { open: 0, pinned: 0, bare: 0, wildcard: 0, setup: 0 };
    let l = await this.listen(send);
    heard.open = l.frames;
    parts.push(`setup ${this.heardText(l)}`);
    await pin();
    l = await this.listen(send);
    heard.pinned = l.frames;
    parts.push(`pinned ${this.heardText(l)}`);
    for (const way of ["bare", "wildcard"] as const) {
      const command = this.reopenCommand(way);
      const r = await send(command, 1000, true);
      l = await this.listen(send);
      heard[way] = r.status === "ok" ? l.frames : 0;
      parts.push(`${command} ${quote(r.raw)} ${this.heardText(l)}`);
      await pin();
    }
    if (!(await this.setup(send))) return false;
    l = await this.listen(send);
    heard.setup = l.frames;
    parts.push(`setup again ${this.heardText(l)}`);
    // The monitor ending by itself after n frames: no stop character, no drain.
    const count = await send("STM 20", 1500, true);
    const frames = count.lines.filter((x) => FRAME_LINE.test(x.replace(/\s+/g, ""))).length;
    const counted = count.status === "ok" && !/\?/.test(count.raw) && frames > 0;
    parts.push(`STM n ${counted ? `accepted (${frames} frames in ${Math.round((count.rxUs - count.txUs) / 1000)} ms)` : quote(count.raw)}`);

    const open = Math.max(heard.open, heard.setup);
    let verdict: string;
    if (open === 0) {
      // A silent bus (or the wrong ids): nothing to tell. Tried again later.
      this.retestLater = true;
      verdict = "nothing heard with the filter open: no verdict";
    } else {
      const chosen = REOPENS.find((way) => heard[way] >= Math.max(1, TEST_MIN_SHARE * open)) ?? "setup";
      this.reopen = chosen;
      verdict = `opens by ${this.reopenName(chosen)} from now on`;
      if (heard.pinned >= Math.max(1, TEST_MIN_SHARE * open)) verdict += `; the pinned filter doesn't stop the monitor`;
    }
    this.deps.onEvent(`filter test: ${parts.join(", ")} → ${verdict}`);
    this.pinned = false;
    return true;
  }

  private heardText(l: { frames: number; other: number; stopped: boolean }): string {
    return `${l.frames}${l.other ? `+${l.other} other` : ""}${l.stopped ? "" : " (no prompt)"}`;
  }

  /** Self-test only: the monitor for TEST_LISTEN_MS, then stopped; the frames heard (not passed on). */
  private async listen(send: RawSend): Promise<{ frames: number; other: number; stopped: boolean }> {
    let frames = 0;
    let other = 0;
    this.collector = new CanMonitorCollector(this.deps.idDigits, (f) => {
      if (this.wantedIds.has(f.id)) frames++;
      else other++;
    });
    this.probing = true;
    this.live = true;
    try {
      await this.deps.writeRaw("STM\r");
      await this.deps.clock.sleep(TEST_LISTEN_MS);
      let r = await send("", 700, true);
      if (r.status === "timeout") r = await send("", 700, true);
      this.collector.push(r.raw, r.rxUs);
      this.collector.end(r.rxUs);
      return { frames, other, stopped: r.status !== "timeout" };
    } finally {
      this.live = false;
      this.probing = false;
      this.collector = null;
    }
  }

  private openWindow(reopen: CanReopen): void {
    // Only the ids asked for: any other is a line that lost its start in transport, or the filter wide open.
    this.collector = new CanMonitorCollector(this.deps.idDigits, (f) => {
      if (!this.wantedIds.has(f.id)) {
        this.garbled++;
        this.windowOther++;
        return;
      }
      this.pending.push(f);
      this.windowFrames++;
    });
    this.windowFrames = 0;
    this.windowBytes = 0;
    this.windowOther = 0;
    this.windowReopen = reopen;
    this.windowStartUs = this.deps.clock.nowUs();
    this.live = true;
  }

  private pinFilter(): string {
    const { pinnedEcu, idDigits } = this.deps;
    if (pinnedEcu !== null) return hex(pinnedEcu, idDigits);
    return idDigits === 3 ? "7EX" : "18DAF1XX";
  }

  private closeWindow(endUs: number, endedItself: boolean, stopMs: number | null, stopRetried: boolean): CanWindow {
    const c = this.collector!;
    c.end(endUs);
    this.flush();
    this.collector = null;
    this.frames += this.windowFrames;
    this.windows++;
    const w: CanWindow = {
      startUs: this.windowStartUs,
      endUs,
      frames: this.windowFrames,
      endedItself,
      bufferFull: c.bufferFullCount,
      bytes: this.windowBytes,
      other: this.windowOther,
      stopMs,
      stopRetried,
      reopen: this.windowReopen,
    };
    this.deps.onWindow(w);
    this.deps.onStatus(this.status);
    if (this.windowFrames > 0) this.deafUs = 0;
    else if ((this.deafUs += endUs - this.windowStartUs) >= DEAF_US) {
      this.deafUs = 0;
      this.nextReopen(`${DEAF_US / 1e6} s of listening heard none of the ids after ${this.reopenName(this.reopen)}`);
    }
    if (this.retestLater && this.testedUs !== null && endUs - this.testedUs >= TEST_RETRY_US) {
      this.retestLater = false;
      this.testedUs = null;
    }
    return w;
  }

  private reopenCommand(way: Exclude<Reopen, "setup">): string {
    return way === "bare" ? "ATCRA" : `ATCRA${this.deps.idDigits === 3 ? "XXX" : "XXXXXXXX"}`;
  }

  private reopenName(way: Reopen): string {
    return way === "setup" ? "a full setup" : this.reopenCommand(way);
  }

  /** The next way to open the filter, from now on; none left: the shadow is off (false). */
  private nextReopen(why: string): boolean {
    const next = REOPENS[REOPENS.indexOf(this.reopen) + 1] ?? null;
    if (!next) {
      this.fail(why);
      return false;
    }
    this.reopen = next;
    this.deps.onEvent(`${why}: the filter opens by ${this.reopenName(next)} from now on`);
    return true;
  }

  /** Whether this own exchange goes into the transcript: the first LOG_FIRST of its kind. */
  private logs(kind: string): boolean {
    const n = this.logCounts.get(kind) ?? 0;
    this.logCounts.set(kind, n + 1);
    return n < LOG_FIRST;
  }

  /** An answer that went wrong, as a link event (the transcript has only the first few of a kind). */
  private wrong(detail: string): void {
    if (this.wrongLogged++ < WRONG_MAX) this.deps.onEvent(detail);
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
