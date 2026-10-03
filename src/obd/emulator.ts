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
  atLatencyMs: number;
  obdLatencyMs: number;
  /** Extra wait when the adapter doesn't know how many answers to expect. */
  multiResponseWaitMs: number;
  /** No-answer timeout (ATST). */
  noDataWaitMs: number;
  searchMs: number;
  vin: string;
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

const SUPPORTED_01 = ["01", "04", "05", "0C", "0D", "0F", "11", "1C", "20"];

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
  private header = 0x7df;
  private receiveFilter: number | null = null;

  constructor(
    private readonly clock: Clock,
    profile: Partial<EmulatorProfile> = {},
  ) {
    this.profile = { ...GENUINE_PROFILE, ...profile };
  }

  setVehicle(state: Partial<VehicleState>): void {
    this.vehicle = { ...this.vehicle, ...state };
  }

  async connect(): Promise<ConnectedInfo> {
    await this.clock.sleep(50);
    this.connected = true;
    this.firstCommand = true;
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

  /** Simulate the adapter dropping off (unplugged / brown-out). */
  dropLink(reason = "emulated link loss"): void {
    this.connected = false;
    this.linkLost.emit(reason);
  }

  onUnsolicited(listener: (text: string, rxUs: number) => void): () => void {
    return this.unsolicited.on(listener);
  }

  onLinkLost(listener: (reason: string) => void): () => void {
    return this.linkLost.on(listener);
  }

  async exchange(command: string, timeoutMs: number): Promise<RawExchange> {
    const txUs = this.clock.nowUs();
    if (!this.connected) throw new Error("not connected");
    this.commandCount++;
    this.log.push(command);

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
    if (cmd === "STI") return { body: [this.profile.stn ?? "?"], delayMs: at };
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
      if (c !== "D") {
        this.protocol = 0;
        this.searched = false;
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
    if (c === "RV") {
      const v = !this.vehicle.ignition ? 12.4 : this.vehicle.rpm > 300 ? 14.2 : 12.2;
      return [`${v.toFixed(1)}V`];
    }
    if (c === "DPN") return [this.protocol === 0 ? (this.searched ? "A6" : "0") : String(this.protocol)];
    if (c.startsWith("SP")) {
      const n = c.slice(2).replace("A", "");
      this.protocol = parseInt(n, 16) || 0;
      if (this.protocol === 0) this.searched = false;
      return ok;
    }
    if (c.startsWith("SH")) {
      if (!this.profile.supportsHeaderSet) return ["?"];
      this.header = parseInt(c.slice(2), 16);
      return ok;
    }
    if (c.startsWith("CRA")) {
      if (!this.profile.supportsHeaderSet) return ["?"];
      this.receiveFilter = parseInt(c.slice(3), 16);
      return ok;
    }
    if (c === "AR") {
      this.receiveFilter = null;
      return ok;
    }
    if (c.startsWith("ST")) return ok;
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
    if (!this.vehicle.ignition) return { body: ["NO DATA"], delayMs: p.noDataWaitMs };

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
      answers = p.ecus.map((ecu) => ({ ecu, data: [0x41, 0x0d, Math.round(this.vehicle.speedKph) & 0xff] }));
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
      return { body: this.vinFrames(engine), delayMs: searchDelay + p.obdLatencyMs + p.multiResponseWaitMs };
    } else {
      return { body: ["NO DATA"], delayMs: searchDelay + p.noDataWaitMs };
    }

    // Physical addressing (ATSH 7E0) → only that ECU answers; receive filter likewise.
    if (this.header !== 0x7df) answers = answers.filter((a) => a.ecu === this.header + 8);
    if (this.receiveFilter !== null) answers = answers.filter((a) => a.ecu === this.receiveFilter);
    if (answers.length === 0) return { body: ["NO DATA"], delayMs: searchDelay + p.noDataWaitMs };

    let delayMs = searchDelay + p.obdLatencyMs;
    if (countDigit !== null) answers = answers.slice(0, countDigit);
    else delayMs += p.multiResponseWaitMs;

    const body = answers.map(({ ecu, data }) => {
      const bytes = this.headers ? [data.length, ...data] : data;
      const parts = bytes.map(hex2);
      const head = this.headers ? ecu.toString(16).toUpperCase() : null;
      const sep = this.spaces ? " " : "";
      return (head ? head + sep : "") + parts.join(sep);
    });
    return { body: [...(searchDelay > 0 ? ["SEARCHING..."] : []), ...body], delayMs };
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
