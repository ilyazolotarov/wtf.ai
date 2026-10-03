// ELM327 command session: one command in flight, priority queue, exclusive sections,
// timeout resync (docs/VEHICLE-LINK-SPEC.md §6.2 rules, §10.5).

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
  private lockWaiters: { owner: symbol; priority: Priority; seq: number; grant(): void }[] = [];

  constructor(private readonly transport: Transport) {}

  send(command: string, opts: SendOptions = {}): Promise<ElmResponse> {
    return this.enqueue(command, opts, null);
  }

  /** Run `fn` with nobody else's commands in between (ELM terminal, multi-step setup). */
  async exclusive<T>(
    fn: (send: (command: string, opts?: SendOptions) => Promise<ElmResponse>) => Promise<T>,
    priority: Priority = Priority.Control,
  ): Promise<T> {
    const owner = Symbol("exclusive");
    await new Promise<void>((grant) => {
      this.lockWaiters.push({ owner, priority, seq: this.seq++, grant });
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
    this.lockWaiters.forEach((w) => w.grant());
    this.lockWaiters = [];
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
    if (this.busy || this.closed) return;
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
    if (!item) return;
    this.queue.splice(this.queue.indexOf(item), 1);
    this.busy = true;
    void this.run(item);
  }

  private async run(item: QueueItem): Promise<void> {
    try {
      const raw = await this.transport.exchange(item.command, item.timeoutMs);
      const parsed =
        raw.status === "timeout" ? { status: "timeout" as const, lines: [] } : parseResponse(item.command, raw.raw);
      const response: ElmResponse = {
        command: item.command,
        status: parsed.status,
        lines: parsed.lines,
        raw: raw.raw,
        txUs: raw.txUs,
        rxUs: raw.rxUs,
      };
      if (raw.status === "timeout") {
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
