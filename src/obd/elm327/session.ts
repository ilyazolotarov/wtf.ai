// ELM327 command session: one command in flight, priority queue, exclusive sections,
// timeout resync (docs/VEHICLE-LINK-SPEC.md §6.2 rules, §10.5).

import { yieldMacrotask } from "../clock";
import { Emitter } from "../emitter";
import type { ElmResponse, Transport } from "../types";
import { parseResponse } from "./parser";

/** Lower value runs first. */
export enum Priority {
  Control = 0,
  Rpm = 1,
  Speed = 2,
}

export interface SendOptions {
  timeoutMs?: number;
  priority?: Priority;
}

interface QueueItem {
  command: string;
  timeoutMs: number;
  priority: Priority;
  seq: number;
  owner: symbol | null;
  resolve(r: ElmResponse): void;
  reject(e: unknown): void;
}

export const DEFAULT_TIMEOUT_MS = 2000;

/** One exchange outside the queue, for an idle monitor; `log`: also emitted on `exchanges` (the transcript). */
export type RawSend = (command: string, timeoutMs: number, log?: boolean) => Promise<ElmResponse>;

/**
 * Runs on the adapter while the session has nothing to send: the CAN monitor (docs/VEHICLE-LINK-SPEC.md §16.2).
 * Started when the queue is empty and no exclusive section is open; stopped before the next command.
 */
export interface IdleMonitor {
  readonly running: boolean;
  /** May it start now? */
  wanted(): boolean;
  start(send: RawSend): Promise<void>;
  /** Resolves with the adapter at its prompt again. */
  stop(send: RawSend): Promise<void>;
}

export class SessionClosedError extends Error {
  constructor() {
    super("ELM327 session closed");
  }
}

export class Elm327Session {
  readonly exchanges = new Emitter<[ElmResponse]>();

  private queue: QueueItem[] = [];
  private busy = false;
  private seq = 0;
  private closed = false;
  /** Owner of the running exclusive section, if any. */
  private lockOwner: symbol | null = null;
  private lockWaiters: { owner: symbol; priority: Priority; seq: number; grant(): void; reject(e: unknown): void }[] = [];
  private monitor: IdleMonitor | null = null;
  /** A replaced monitor still running: the next command stops it. */
  private stale: IdleMonitor | null = null;
  private monitorPending = false;

  constructor(private readonly transport: Transport) {}

  /** Replace the idle monitor; a running one is stopped before the next command, as always. */
  setIdleMonitor(monitor: IdleMonitor | null): void {
    if (this.monitor?.running && monitor !== this.monitor) this.stale = this.monitor;
    this.monitor = monitor;
    this.pump();
  }

  send(command: string, opts: SendOptions = {}): Promise<ElmResponse> {
    return this.enqueue(command, opts, null);
  }

  /** Run `fn` with nobody else's commands in between (ELM terminal, multi-step setup). */
  async exclusive<T>(
    fn: (send: (command: string, opts?: SendOptions) => Promise<ElmResponse>) => Promise<T>,
    priority: Priority = Priority.Control,
  ): Promise<T> {
    if (this.closed) throw new SessionClosedError();
    const owner = Symbol("exclusive");
    await new Promise<void>((grant, reject) => {
      this.lockWaiters.push({ owner, priority, seq: this.seq++, grant, reject });
      this.pump();
    });
    try {
      return await fn((command, opts = {}) => this.enqueue(command, opts, owner));
    } finally {
      this.lockOwner = null;
      this.pump();
    }
  }

  close(): void {
    this.closed = true;
    const pending = this.queue;
    this.queue = [];
    pending.forEach((item) => item.reject(new SessionClosedError()));
    this.rejectWaiters();
  }

  /** Closed: nobody gets the lock any more (a waiter that was granted would only see its sends rejected). */
  private rejectWaiters(): void {
    const waiters = this.lockWaiters;
    this.lockWaiters = [];
    waiters.forEach((w) => w.reject(new SessionClosedError()));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private enqueue(command: string, opts: SendOptions, owner: symbol | null): Promise<ElmResponse> {
    if (this.closed) return Promise.reject(new SessionClosedError());
    return new Promise((resolve, reject) => {
      this.queue.push({
        command,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        priority: opts.priority ?? Priority.Control,
        seq: this.seq++,
        owner,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  private pickNext(): QueueItem | undefined {
    const eligible = this.queue.filter((item) => item.owner === this.lockOwner);
    if (eligible.length === 0) return undefined;
    eligible.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    return eligible[0];
  }

  private pump(): void {
    if (this.closed) {
      this.rejectWaiters();
      return;
    }
    if (this.busy) return;
    if (this.lockOwner === null && this.lockWaiters.length > 0) {
      // Grant the lock unless a more urgent plain command is waiting.
      this.lockWaiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const waiter = this.lockWaiters[0];
      const plain = this.queue
        .filter((i) => i.owner === null)
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
      if (!plain || plain.priority > waiter.priority || (plain.priority === waiter.priority && plain.seq > waiter.seq)) {
        this.lockWaiters.shift();
        this.lockOwner = waiter.owner;
        waiter.grant();
        return;
      }
    }
    const item = this.pickNext();
    if (!item) {
      this.maybeStartMonitor();
      return;
    }
    this.queue.splice(this.queue.indexOf(item), 1);
    this.busy = true;
    void this.run(item);
  }

  private idle(): boolean {
    return !this.busy && !this.closed && this.lockOwner === null && this.lockWaiters.length === 0 && this.queue.length === 0;
  }

  /** Idle: start the monitor after a macrotask, so back-to-back commands don't start and stop it in between. */
  private maybeStartMonitor(): void {
    if (this.monitorPending || !this.idle() || !this.monitor || this.monitor.running || !this.monitor.wanted()) return;
    this.monitorPending = true;
    yieldMacrotask(() => {
      this.monitorPending = false;
      const monitor = this.monitor;
      if (!monitor || monitor.running || !this.idle() || !monitor.wanted()) return;
      this.busy = true;
      void monitor
        .start(this.rawSend)
        .catch(() => undefined)
        .finally(() => {
          this.busy = false;
          this.pump();
        });
    });
  }

  private rawSend: RawSend = async (command, timeoutMs, log = false) => {
    const response = await this.exchange(command, timeoutMs);
    if (log) this.exchanges.emit(response);
    return response;
  };

  private async exchange(command: string, timeoutMs: number): Promise<ElmResponse> {
    const raw = await this.transport.exchange(command, timeoutMs);
    const parsed = raw.status === "timeout" ? { status: "timeout" as const, lines: [] } : parseResponse(command, raw.raw);
    return { command, status: parsed.status, lines: parsed.lines, raw: raw.raw, txUs: raw.txUs, rxUs: raw.rxUs };
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      for (const m of [this.stale, this.monitor]) if (m?.running) await m.stop(this.rawSend).catch(() => undefined);
      this.stale = null;
      const response = await this.exchange(item.command, item.timeoutMs);
      if (response.status === "timeout") {
        // Get back in sync: a bare CR interrupts a busy ELM and yields a prompt.
        await this.transport.exchange("", 500).catch(() => undefined);
      }
      this.exchanges.emit(response);
      item.resolve(response);
    } catch (error) {
      item.reject(error);
    } finally {
      this.busy = false;
      this.pump();
    }
  }
}
