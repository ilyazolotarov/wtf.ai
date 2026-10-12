// ELM327 adapter + vehicle emulator implementing Transport (docs/VEHICLE-LINK-SPEC.md §13).
// Used by unit tests and as a fake adapter in the dev UI.

import type { Clock } from "./clock";
import { Emitter } from "./emitter";
import type { ConnectedInfo, RawExchange, Transport } from "./types";

export interface EmulatorProfile {
  /** false → never answers (not an ELM327 device). */
  isElm: boolean;
  banner: string;
  description: string | null;
  /** STI answer, null → "?". */
  stn: string | null;
  supportsResponseCount: boolean;
  supportsAdaptiveTiming2: boolean;
  supportsHeaderSet: boolean;
  dropFirstCommand: boolean;
  lineEnding: "\r" | "\r\n";
  nulBytes: boolean;
  /** ECUs answering functional requests for speed. First is the engine ECU. */
  ecus: number[];
  /** ECUs answering 010D, if not all of `ecus` (the engine ECU can miss the speed probe at init). */
  speedEcus?: number[];
  atLatencyMs: number;
  obdLatencyMs: number;
  /** Extra wait when the adapter doesn't know how many answers to expect. */
  multiResponseWaitMs: number;
  /** No-answer timeout (ATST). */
  noDataWaitMs: number;
  searchMs: number;
  vin: string;
  /** The car's OBD protocol (ATSP number): 6 = CAN 11-bit 500k, 5 = ISO 14230 KWP fast init (K-line). */
  carProtocol: number;
  /** The first this many `0902` requests get NO DATA (the VIN read missing at init on the CX-5). */
  vinMisses: number;
  /**
   * K-line: how long the ECU keeps a session after its last request (KWP2000 P3max). An init while it is open fails
   * (the ECU ignores it): after the adapter drops its session (`ATSP0`, a reset) the car is unreachable this long.
   * 0: not modelled.
   */
  klineSessionMs?: number;
  /** CAN frames the car broadcasts while the ignition is on, for the STN monitor (`STM`). */
  broadcast?: { id: number; periodMs: number; data: number[] }[];
  /** STN pass filters also pass broadcast frames into request answers (one arrives before the ECU's answer). */
  passFiltersLeak?: boolean;
  /**
   * A bare `ATCRA` (open the receive filter again): `refused` answers `?`, `ignored` answers OK and keeps the filter,
   * `default` restores the protocol's filter (the OBD answers) and clears the pass filters, as the manual says and
   * the OBDLink MX+ on 5.13.1 and the vLinker do (2026-10-12). Each explains a monitor that hears nothing after its
   * first break.
   */
  bareAtcra?: "refused" | "ignored" | "default";
  /** An all-pass `ATCRAXXX` answers OK and keeps the filter (only a full setup opens it). */
  wildcardAtcraIgnored?: boolean;
  /** `STM n` (a monitor window ending by itself after n frames, MX+ firmware 5.12.4+) answers `?`. */
  stmCountUnsupported?: boolean;
}

export interface VehicleState {
  ignition: boolean;
  rpm: number;
  speedKph: number;
  /** Engine stopped but the ECU answers 010C with this RPM latched at shutdown (seen on a Mazda CX-5). */
  rpmLatched?: number;
}

export const GENUINE_PROFILE: EmulatorProfile = {
  isElm: true,
  banner: "ELM327 v1.5",
  description: "OBDII to RS232 Interpreter",
  stn: null,
  supportsResponseCount: true,
  supportsAdaptiveTiming2: true,
  supportsHeaderSet: true,
  dropFirstCommand: false,
  lineEnding: "\r",
  nulBytes: false,
  ecus: [0x7e8, 0x7e9],
  atLatencyMs: 5,
  obdLatencyMs: 40,
  multiResponseWaitMs: 60,
  noDataWaitMs: 200,
  searchMs: 1500,
  vin: "JM3KFBDM1J0123456",
  carProtocol: 6,
  vinMisses: 0,
};

export const CLONE_PROFILE: EmulatorProfile = {
  ...GENUINE_PROFILE,
  banner: "ELM327 v2.1",
  description: null,
  supportsResponseCount: false,
  supportsAdaptiveTiming2: false,
  supportsHeaderSet: false,
  dropFirstCommand: true,
  lineEnding: "\r\n",
  nulBytes: true,
  obdLatencyMs: 80,
  multiResponseWaitMs: 100,
};

export const STN_PROFILE: EmulatorProfile = {
  ...GENUINE_PROFILE,
  banner: "ELM327 v1.4b",
  description: "OBDLink MX+",
  stn: "STN2255 v5.10.3",
  obdLatencyMs: 25,
};

/** A K-line car (a Renault Logan: KWP2000 fast init, the engine ECU at 7A) on an OBDLink. */
export const KLINE_PROFILE: Partial<EmulatorProfile> = {
  ...STN_PROFILE,
  carProtocol: 5,
  klineSessionMs: 5000,
  ecus: [0x7a],
  obdLatencyMs: 60,
  vin: "VF1LSRAEH12345678",
};

const SUPPORTED_01 = ["01", "04", "05", "0C", "0D", "0F", "11", "1C", "20"];
const isCan = (protocol: number) => protocol >= 6 && protocol <= 9;

function bitmap(pids: string[]): number[] {
  const bytes = [0, 0, 0, 0];
  for (const p of pids) {
    const i = parseInt(p, 16) - 1;
    if (i >= 0 && i < 32) bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  return bytes;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");

export class Elm327Emulator implements Transport {
  readonly kind = "emulator" as const;
  readonly profile: EmulatorProfile;
  vehicle: VehicleState = { ignition: true, rpm: 800, speedKph: 0 };
  private rpmReads = 0;

  private unsolicited = new Emitter<[string, number]>();
  private linkLost = new Emitter<[string]>();
  private connected = false;
  private firstCommand = true;
  private lastCommand = "";
  /** Count of commands handled, for tests. */
  commandCount = 0;
  readonly log: string[] = [];
  private desyncWhen: ((command: string) => boolean) | null = null;
  private heldReply: string | null = null;

  // ELM state
  private echo = true;
  private spaces = true;
  private headers = false;
  private protocol = 0;
  private searched = false;
  /** K-line: the adapter has an open session with the ECU, and until when the ECU holds its side (µs). */
  private klineOpen = false;
  private ecuSessionUntilUs = 0;
  private header = 0x7df;
  /** CAN hardware filter (ATCRA, `X` digits don't care); null: open. */
  private receiveFilter: { pattern: number; mask: number } | null = null;
  private vinRequests = 0;
  /** STN pass filters (`STFPA pattern,mask`) and the monitor (`STM`). */
  private passFilters: { pattern: number; mask: number }[] = [];
  private monitoring = false;
  private stopIgnored: "next" | "now" | null = null;
  private monitorStartUs = 0;
  private broadcastSent: number[] = [];
  private frozen: "until-reconnect" | "for-good" | null = null;
  private freezeAtMonitor: "until-reconnect" | "for-good" | null = null;
  private poweredOff = false;
  private powerOffAtMonitor = false;

  constructor(
    private readonly clock: Clock,
    profile: Partial<EmulatorProfile> = {},
  ) {
    this.profile = { ...GENUINE_PROFILE, ...profile };
  }

  /** K-line: the ECU holds a session from before (another connection) for this long more. */
  holdEcuSession(ms: number): void {
    this.klineOpen = false;
    this.ecuSessionUntilUs = this.clock.nowUs() + ms * 1000;
  }

  setVehicle(state: Partial<VehicleState>): void {
    this.vehicle = { ...this.vehicle, ...state };
  }

  async connect(): Promise<ConnectedInfo> {
    await this.clock.sleep(50);
    if (this.poweredOff) throw new Error("adapter not reachable");
    this.connected = true;
    this.firstCommand = true;
    if (this.frozen === "until-reconnect") this.frozen = null;
    return { deviceInfo: { name: "Emulator", model: this.profile.banner } };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /**
   * Simulate a reply arriving one command late (seen on a real OBDLink MX+): the next
   * command (or the first one `when` accepts) gets a stale "STOPPED"; its own reply answers
   * the command after it, which is lost.
   */
  desyncOnce(when: (command: string) => boolean = () => true): void {
    this.desyncWhen = when;
  }

  /**
   * Simulate the adapter going silent with the link up (2026-10-11, an OBDLink MX+ at 39 km/h): no byte comes back,
   * the monitor stops too. `untilReconnect`: a new connection brings it back (the link froze, not the adapter).
   */
  freeze(untilReconnect = true): void {
    this.frozen = untilReconnect ? "until-reconnect" : "for-good";
    this.monitoring = false;
  }

  /**
   * The car switched off at the next `STM` (with the monitor running, as on 2026-10-11): the adapter goes silent and
   * can't be reached until `powerOn`.
   */
  powerOffInMonitor(): void {
    this.powerOffAtMonitor = true;
  }

  powerOn(): void {
    this.poweredOff = false;
    this.frozen = null;
  }

  /**
   * The next stop character gets no answer: the monitor goes quiet and the exchange times out; the one after stops it
   * (the vLinker, 4 in 600 windows on 2026-10-12).
   */
  ignoreNextStop(): void {
    this.stopIgnored = "next";
  }

  /** `freeze()` at the next `STM`: inside a monitor window, as both freezes seen. */
  freezeInMonitor(untilReconnect = true): void {
    this.freezeAtMonitor = untilReconnect ? "until-reconnect" : "for-good";
  }

  /** Simulate the adapter dropping off (unplugged / brown-out). */
  dropLink(reason = "emulated link loss"): void {
    this.connected = false;
    this.linkLost.emit(reason);
  }

  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void {
    return this.unsolicited.on(listener);
  }

  /** Only `STM` (STN monitor): its frames arrive as unsolicited text until the next command stops it. */
  async writeRaw(text: string): Promise<void> {
    if (!this.connected) throw new Error("not connected");
    this.log.push(text.trim());
    if (this.frozen) return;
    if (text.trim().toUpperCase() !== "STM" || !this.profile.stn) return;
    if (this.powerOffAtMonitor) {
      this.powerOffAtMonitor = false;
      this.poweredOff = true;
      this.frozen = "for-good";
      return;
    }
    if (this.freezeAtMonitor) {
      this.frozen = this.freezeAtMonitor;
      this.freezeAtMonitor = null;
      return;
    }
    this.monitoring = true;
    this.monitorStartUs = this.clock.nowUs();
    this.broadcastSent = (this.profile.broadcast ?? []).map(() => 0);
    void this.monitorLoop();
  }

  private async monitorLoop(): Promise<void> {
    const eol = this.profile.lineEnding;
    while (this.monitoring && this.connected) {
      await this.clock.sleep(20);
      if (!this.monitoring) return;
      if (this.stopIgnored === "now") continue;
      const lines = this.dueFrames();
      if (lines.length > 0) this.unsolicited.emit(lines.join(eol) + eol, this.clock.nowUs());
    }
  }

  /**
   * Broadcast frames sent since the last call that pass the CAN hardware filter (ATCRA) and a pass filter; with none
   * set, every id (2026-10-12: ATCRAXXX after the pass filters were cleared heard every id on the bus).
   */
  private dueFrames(): string[] {
    const lines: string[] = [];
    const elapsedUs = this.clock.nowUs() - this.monitorStartUs;
    (this.profile.broadcast ?? []).forEach((b, i) => {
      const due = Math.floor(elapsedUs / (b.periodMs * 1000));
      const passes = this.broadcastPasses(b.id, true);
      for (; this.broadcastSent[i] < due; this.broadcastSent[i]++) if (passes) lines.push(this.broadcastLine(b));
    });
    return lines;
  }

  private receives(id: number): boolean {
    return this.receiveFilter === null || (id & this.receiveFilter.mask) === (this.receiveFilter.pattern & this.receiveFilter.mask);
  }

  private broadcastPasses(id: number, monitor = false): boolean {
    if (!this.vehicle.ignition || !this.receives(id)) return false;
    if (monitor && this.passFilters.length === 0) return true;
    return this.passFilters.some((f) => (id & f.mask) === (f.pattern & f.mask));
  }

  private broadcastLine(b: { id: number; data: number[] }): string {
    const sep = this.spaces ? " " : "";
    return [...(this.headers ? [b.id.toString(16).toUpperCase().padStart(3, "0")] : []), ...b.data.map(hex2)].join(sep);
  }

  onLinkLost(listener: (reason: string) => void): () => void {
    return this.linkLost.on(listener);
  }

  async exchange(command: string, timeoutMs: number): Promise<RawExchange> {
    const txUs = this.clock.nowUs();
    if (!this.connected) throw new Error("not connected");
    this.commandCount++;
    this.log.push(command);
    if (this.frozen) {
      await this.clock.sleep(timeoutMs);
      return { raw: "", status: "timeout", txUs, rxUs: this.clock.nowUs() };
    }

    if (this.monitoring && this.stopIgnored === "next") {
      this.stopIgnored = "now";
      await this.clock.sleep(timeoutMs);
      return { raw: "", status: "timeout", txUs, rxUs: this.clock.nowUs() };
    }
    if (this.monitoring) {
      // Any character stops the monitor: the frames still buffered, STOPPED, the prompt.
      this.monitoring = false;
      this.stopIgnored = null;
      const eol = this.profile.lineEnding;
      await this.clock.sleep(this.profile.atLatencyMs);
      const raw = [...this.dueFrames(), "STOPPED"].join(eol) + eol + eol + ">";
      return { raw, status: "ok", txUs, rxFirstUs: this.clock.nowUs(), rxUs: this.clock.nowUs() };
    }

    if (!this.profile.isElm || (this.profile.dropFirstCommand && this.firstCommand)) {
      this.firstCommand = false;
      await this.clock.sleep(timeoutMs);
      return { raw: "", status: "timeout", txUs, rxUs: this.clock.nowUs() };
    }
    this.firstCommand = false;

    const eol = this.profile.lineEnding;
    if (this.heldReply !== null) {
      const raw = this.heldReply;
      this.heldReply = null;
      await this.clock.sleep(this.profile.atLatencyMs);
      return { raw, status: "ok", txUs, rxFirstUs: this.clock.nowUs(), rxUs: this.clock.nowUs() };
    }

    let cmd = command.replace(/\s+/g, "").toUpperCase();
    if (cmd === "") cmd = this.lastCommand;
    else this.lastCommand = cmd;

    const { body, delayMs } = this.respond(cmd);
    const totalDelay = delayMs;
    if (totalDelay > timeoutMs) {
      await this.clock.sleep(timeoutMs);
      return { raw: "", status: "timeout", txUs, rxUs: this.clock.nowUs() };
    }
    await this.clock.sleep(totalDelay);
    let raw = (this.echo ? command + eol : "") + body.join(eol) + eol + eol + ">";
    if (this.profile.nulBytes) raw = "\0" + raw;
    if (this.desyncWhen?.(cmd)) {
      this.desyncWhen = null;
      this.heldReply = raw;
      raw = `STOPPED${eol}${eol}>`;
    }
    const rxUs = this.clock.nowUs();
    return { raw, status: "ok", txUs, rxFirstUs: rxUs, rxUs };
  }

  private respond(cmd: string): { body: string[]; delayMs: number } {
    const at = this.profile.atLatencyMs;
    if (cmd === "") return { body: ["?"], delayMs: at };
    if (cmd.startsWith("AT")) return { body: this.atCommand(cmd.slice(2)), delayMs: at };
    const count = /^STM(\d+)$/.exec(cmd);
    if (count && this.profile.stn) {
      if (this.profile.stmCountUnsupported) return { body: ["?"], delayMs: at };
      // The next n frames that pass the filters, one every 10 ms; none passing: it never comes back (a timeout).
      const n = Number(count[1]);
      const passing = (this.profile.broadcast ?? []).filter((b) => this.broadcastPasses(b.id));
      if (!passing.length) return { body: [], delayMs: 1e9 };
      return { body: Array.from({ length: n }, (_, i) => this.broadcastLine(passing[i % passing.length])), delayMs: n * 10 };
    }
    if (cmd === "STI") return { body: [this.profile.stn ?? "?"], delayMs: at };
    if (cmd.startsWith("ST")) return { body: this.stnCommand(cmd.slice(2)), delayMs: at };
    if (/^[0-9A-F]+$/.test(cmd)) return this.obdCommand(cmd);
    return { body: ["?"], delayMs: at };
  }

  private atCommand(c: string): string[] {
    const ok = ["OK"];
    if (c === "Z" || c === "WS" || c === "D") {
      this.echo = true;
      this.spaces = true;
      this.headers = false;
      this.header = 0x7df;
      this.receiveFilter = null;
      this.passFilters = [];
      if (c !== "D") {
        this.protocol = 0;
        this.searched = false;
        this.klineOpen = false;
      }
      return c === "D" ? ok : ["", this.profile.banner];
    }
    if (c === "E0" || c === "E1") {
      this.echo = c === "E1";
      return ok;
    }
    if (c === "L0" || c === "L1") return ok;
    if (c === "S0" || c === "S1") {
      this.spaces = c === "S1";
      return ok;
    }
    if (c === "H0" || c === "H1") {
      this.headers = c === "H1";
      return ok;
    }
    if (c === "AT0" || c === "AT1") return ok;
    if (c === "AT2") return this.profile.supportsAdaptiveTiming2 ? ok : ["?"];
    if (c === "I") return [this.profile.banner];
    if (c === "@1") return [this.profile.description ?? "?"];
    if (c === "CS") return ["T:00 R:00"];
    if (c === "RV") {
      const v = !this.vehicle.ignition ? 12.4 : this.vehicle.rpm > 300 ? 14.2 : 12.2;
      return [`${v.toFixed(1)}V`];
    }
    if (c === "DPN") return [this.protocol === 0 ? (this.searched ? `A${this.profile.carProtocol}` : "0") : String(this.protocol)];
    if (c.startsWith("SP")) {
      const n = c.slice(2).replace("A", "");
      this.protocol = parseInt(n, 16) || 0;
      if (this.protocol === 0) this.searched = false;
      // Setting the protocol the session is on keeps it; a search or another protocol closes it.
      if (this.protocol !== this.profile.carProtocol) this.klineOpen = false;
      return ok;
    }
    if (c.startsWith("SH")) {
      if (!this.profile.supportsHeaderSet) return ["?"];
      this.header = parseInt(c.slice(2), 16);
      return ok;
    }
    if (c.startsWith("CRA")) {
      if (!this.profile.supportsHeaderSet) return ["?"];
      const digits = c.slice(3);
      if (digits === "" && this.profile.bareAtcra === "refused") return ["?"];
      if (digits === "" && this.profile.bareAtcra === "ignored") return ok;
      if (digits === "" && this.profile.bareAtcra === "default") {
        this.receiveFilter = { pattern: 0x7e8, mask: 0x7f8 };
        this.passFilters = [];
        return ok;
      }
      if (/^X+$/.test(digits) && this.profile.wildcardAtcraIgnored) return ok;
      this.receiveFilter =
        digits === ""
          ? null
          : {
              pattern: parseInt(digits.replace(/X/g, "0"), 16),
              mask: parseInt(digits.replace(/[0-9A-F]/g, "F").replace(/X/g, "0"), 16),
            };
      return ok;
    }
    if (c === "AR") {
      this.receiveFilter = null;
      this.passFilters = [];
      return ok;
    }
    if (c.startsWith("ST")) return ok;
    return ["?"];
  }

  private stnCommand(c: string): string[] {
    if (!this.profile.stn) return ["?"];
    if (c.startsWith("FPA") || c.startsWith("FAP")) {
      const [pattern, mask] = c.slice(3).split(",").map((h) => parseInt(h, 16));
      if (!Number.isFinite(pattern) || !Number.isFinite(mask)) return ["?"];
      this.passFilters.push({ pattern, mask });
      return ["OK"];
    }
    if (c === "FPC" || c === "FAC") {
      this.passFilters = [];
      return ["OK"];
    }
    if (/^CMM[0-2]$/.test(c)) return ["OK"];
    return ["?"];
  }

  private obdCommand(cmd: string): { body: string[]; delayMs: number } {
    const p = this.profile;
    let searchDelay = 0;
    if (this.protocol === 0 && !this.searched) {
      if (!this.vehicle.ignition) {
        return { body: ["SEARCHING...", "UNABLE TO CONNECT"], delayMs: p.searchMs };
      }
      this.searched = true;
      searchDelay = p.searchMs;
    }
    // Another car's protocol: nothing on the CAN pins acknowledges, or nobody answers the K-line init.
    if (this.protocol !== 0 && this.protocol !== p.carProtocol) {
      return { body: [isCan(this.protocol) ? "CAN ERROR" : "BUS INIT: ...ERROR"], delayMs: p.noDataWaitMs };
    }
    if (!this.vehicle.ignition) return { body: ["NO DATA"], delayMs: p.noDataWaitMs };
    // K-line: a new session needs an init, which the ECU ignores while its previous session is open.
    if (p.klineSessionMs && !this.klineOpen) {
      if (this.clock.nowUs() < this.ecuSessionUntilUs) {
        if (searchDelay > 0) this.searched = false;
        return searchDelay > 0
          ? { body: ["SEARCHING...", "UNABLE TO CONNECT"], delayMs: searchDelay }
          : { body: ["BUS INIT: ...ERROR"], delayMs: p.noDataWaitMs };
      }
      this.klineOpen = true;
    }
    if (p.klineSessionMs) this.ecuSessionUntilUs = this.clock.nowUs() + searchDelay * 1000 + p.klineSessionMs * 1000;

    let countDigit: number | null = null;
    let request = cmd;
    if (cmd.length % 2 === 1) {
      if (!p.supportsResponseCount) return { body: ["?"], delayMs: p.atLatencyMs };
      countDigit = parseInt(cmd.slice(-1), 16);
      request = cmd.slice(0, -1);
    }
    const mode = request.slice(0, 2);
    const pid = request.slice(2, 4);

    let answers: { ecu: number; data: number[] }[] = [];
    const engine = p.ecus[0];
    if (mode === "01" && pid === "00") {
      answers = p.ecus.map((ecu) => ({ ecu, data: [0x41, 0x00, ...bitmap(SUPPORTED_01)] }));
    } else if (mode === "01" && pid === "0D") {
      answers = (p.speedEcus ?? p.ecus).map((ecu) => ({ ecu, data: [0x41, 0x0d, Math.round(this.vehicle.speedKph) & 0xff] }));
    } else if (mode === "01" && pid === "0C") {
      // A running engine never reports the same RPM twice in a row: jitter by ±0.25 rpm.
      const { rpm, rpmLatched } = this.vehicle;
      const raw =
        rpmLatched !== undefined
          ? Math.round(rpmLatched * 4)
          : rpm > 0
            ? Math.round(rpm * 4) + (this.rpmReads++ % 3) - 1
            : 0;
      answers = [{ ecu: engine, data: [0x41, 0x0c, (raw >> 8) & 0xff, raw & 0xff] }];
    } else if (mode === "09" && pid === "02") {
      // Only the engine ECU has the VIN; another one addressed physically refuses (seen on a CX-5 TCM).
      if (this.header !== 0x7df && this.header + 8 !== engine) return { body: ["7F0912"], delayMs: searchDelay + p.obdLatencyMs };
      if (this.vinRequests++ < p.vinMisses) return { body: ["NO DATA"], delayMs: searchDelay + p.noDataWaitMs };
      const frames = isCan(p.carProtocol) ? this.vinFrames(engine) : this.vinLines(engine);
      return { body: frames, delayMs: searchDelay + p.obdLatencyMs + p.multiResponseWaitMs };
    } else {
      return { body: ["NO DATA"], delayMs: searchDelay + p.noDataWaitMs };
    }

    // Physical addressing (ATSH 7E0) → only that ECU answers; receive filter likewise.
    if (this.header !== 0x7df) answers = answers.filter((a) => a.ecu === this.header + 8);
    answers = answers.filter((a) => this.receives(a.ecu));
    if (answers.length === 0) return { body: ["NO DATA"], delayMs: searchDelay + p.noDataWaitMs };

    let delayMs = searchDelay + p.obdLatencyMs;
    let body = answers.map(({ ecu, data }) => this.frame(ecu, data));
    const leaked = p.passFiltersLeak ? (p.broadcast ?? []).find((b) => this.broadcastPasses(b.id)) : undefined;
    if (leaked) body = [this.broadcastLine(leaked), ...body];
    if (countDigit !== null) body = body.slice(0, countDigit);
    else delayMs += p.multiResponseWaitMs;
    return { body: [...(searchDelay > 0 ? ["SEARCHING..."] : []), ...body], delayMs };
  }

  /** One answer as the adapter prints it: CAN id + PCI, or a K-line header (format, target, source) + checksum. */
  private frame(ecu: number, data: number[]): string {
    const sep = this.spaces ? " " : "";
    if (!this.headers) return data.map(hex2).join(sep);
    if (isCan(this.profile.carProtocol)) return [ecu.toString(16).toUpperCase(), ...[data.length, ...data].map(hex2)].join(sep);
    const bytes = [0x80 | data.length, 0xf1, ecu, ...data];
    return [...bytes, bytes.reduce((a, b) => a + b, 0) & 0xff].map(hex2).join(sep);
  }

  /** K-line VIN: five `49 02 n` messages of four bytes, the first padded with zeros. */
  private vinLines(ecu: number): string[] {
    const bytes = [0, 0, 0, ...[...this.profile.vin].map((c) => c.charCodeAt(0))];
    const lines: string[] = [];
    for (let i = 0, n = 1; i < bytes.length; i += 4, n++) lines.push(this.frame(ecu, [0x49, 0x02, n, ...bytes.slice(i, i + 4)]));
    return lines;
  }

  private vinFrames(ecu: number): string[] {
    const payload = [0x49, 0x02, 0x01, ...[...this.profile.vin].map((c) => c.charCodeAt(0))];
    const sep = this.spaces ? " " : "";
    const frames: string[] = [hex2(payload.length).padStart(3, "0")];
    const first = payload.slice(0, 6);
    frames.push(`0:${sep}${first.map(hex2).join(sep)}`);
    for (let i = 6, n = 1; i < payload.length; i += 7, n++) {
      frames.push(`${n & 0xf}:${sep}${payload.slice(i, i + 7).map(hex2).join(sep)}`);
    }
    void ecu;
    return frames;
  }
}
