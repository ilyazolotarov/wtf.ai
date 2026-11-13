// Verification on connect (docs/VEHICLE-LINK-SPEC.md §8.1).

import type { ElmResponse, ElmStatus } from "../types";
import { parseElmVersion, parseMode01, parseProtocolNumber, parseVoltage } from "./parser";

type Send = (command: string, opts?: { timeoutMs?: number }) => Promise<ElmResponse>;

export interface ProbeResult {
  ok: boolean;
  /** Probe step that failed, for the dev UI. */
  failedStep?: string;
  /**
   * Not a byte came back to the reset, nor to ATWS or ATI: nothing at the other end talks. For an adapter that worked
   * before, most likely another phone holds it (VEHICLE-LINK-SPEC §8.1), or it locked up.
   */
  silent?: boolean;
  /**
   * How the adapter was met, before the reset: still sending the bus's frames (a link lost under the CAN monitor left
   * it listening), set up as the last session left it (no echo: not reset or powered down since), or at its defaults.
   * Null: its answers tell neither.
   */
  met: AdapterMet | null;
  elmVersion: string | null;
  description: string | null;
  chip: string | null;
  suspectedClone: boolean;
  batteryV: number | null;
  /** Vehicle answered `0100`. */
  vehiclePresent: boolean;
  /** The protocol a search found after the cached one failed (0: found, number unknown); init must use it. */
  foundProtocol: number | null;
  warnings: string[];
}

export type AdapterMet = "monitoring" | "configured" | "defaults";

const BANNER = /ELM|STN|OBDLINK/i;
/** A line of the monitor's output: an id and its data bytes in hex. */
const FRAME = /^[0-9A-F ]{4,}$/i;

/**
 * What the flush and the reset say about the adapter before them. A monitor still running answers the flush with its
 * frames (an ELM ends them with `STOPPED`; a poll answer repeated by the bare CR is a line or two, not four). An
 * adapter that echoes the reset is at its defaults; one that doesn't kept the last session's `ATE0`.
 */
function metAs(flush: ElmResponse, reset: ElmResponse): AdapterMet | null {
  const frames = flush.raw.split(/[\r\n]+/).filter((line) => FRAME.test(line.trim())).length;
  if (/STOPPED/.test(flush.raw) || frames >= 4) return "monitoring";
  if (!BANNER.test(reset.raw)) return null;
  return /^[\s\0]*ATZ/i.test(reset.raw) ? "defaults" : "configured";
}

function text(r: ElmResponse): string {
  return r.lines.join(" ");
}

/**
 * ATWS until the banner shows up. After an interrupted command the first reply can be a
 * stale "STOPPED"; the banner then arrives as the answer to the next command (which the
 * resetting adapter drops), so another ATWS collects it instead of the following setup.
 */
export async function warmReset(send: Send, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const r = await send("ATWS", { timeoutMs: 3000 });
    if (r.status !== "timeout" && BANNER.test(text(r))) return true;
  }
  return false;
}

export interface ProbeOptions {
  /** Cached protocol number for the vehicle check, else auto (0). */
  protocol?: number | null;
  /** Skip the vehicle check (reconnect fast path decides itself). */
  skipVehicleCheck?: boolean;
  /** A protocol search starts (true) and ends (false): it takes seconds, worth showing. */
  onSearch?(active: boolean): void;
}

export async function probeAdapter(send: Send, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const result: ProbeResult = {
    ok: false,
    met: null,
    elmVersion: null,
    description: null,
    chip: null,
    suspectedClone: false,
    batteryV: null,
    vehiclePresent: false,
    foundProtocol: null,
    warnings: [],
  };

  // Whether anything at all came back while resetting.
  let heard = false;
  const resetSend: Send = async (command, o) => {
    const r = await send(command, o);
    if (r.raw !== "") heard = true;
    return r;
  };

  // 2. Flush half-typed input; some clones drop the first command after connect.
  const flush = await resetSend("", { timeoutMs: 1000 });

  // 3. Reset.
  let reset = await resetSend("ATZ", { timeoutMs: 3000 });
  result.met = metAs(flush, reset);
  if (reset.status === "timeout" || !BANNER.test(text(reset))) {
    reset = await resetSend("ATWS", { timeoutMs: 3000 });
  }
  if (reset.status === "timeout" || !BANNER.test(text(reset))) {
    // Some adapters answer ATZ with a bare prompt; accept if ATI identifies them.
    const ati = await resetSend("ATI", { timeoutMs: 1000 });
    if (ati.status !== "ok" || !BANNER.test(text(ati))) {
      result.failedStep = "reset";
      result.silent = !heard;
      return result;
    }
    reset = ati;
  }
  result.elmVersion = parseElmVersion(reset.lines);

  // 4. Echo off; once more without an OK, as in the init (§9.1): after a reconnect the reset's banner can come one
  // command late, as the answer to this one (a Viecar and a vLinker FD failed here on the first probe after the link
  // came back, 2026-10-15 to 10-24).
  let echo = await send("ATE0", { timeoutMs: 1000 });
  if (echo.status !== "ok" || !/OK/i.test(text(echo))) echo = await send("ATE0", { timeoutMs: 1000 });
  if (echo.status !== "ok" || !/OK/i.test(text(echo))) {
    result.failedStep = "echo-off";
    return result;
  }
  result.ok = true;

  // 5–8. Identification (all optional).
  const ati = await send("ATI", { timeoutMs: 1000 });
  if (ati.status === "ok") result.elmVersion = parseElmVersion(ati.lines) ?? result.elmVersion;
  result.suspectedClone = /v2\.1\b/.test(result.elmVersion ?? "");

  const desc = await send("AT@1", { timeoutMs: 1000 });
  if (desc.status === "ok" && desc.lines.length > 0) result.description = text(desc);

  const sti = await send("STI", { timeoutMs: 1000 });
  if (sti.status === "ok" && /STN/i.test(text(sti))) result.chip = text(sti);

  const rv = await send("ATRV", { timeoutMs: 1000 });
  result.batteryV = rv.status === "ok" ? parseVoltage(rv.lines) : null;
  if (result.batteryV === null) result.warnings.push("no battery voltage (ATRV)");
  else if (result.batteryV < 9 || result.batteryV > 16) result.warnings.push(`implausible voltage ${result.batteryV} V`);

  if (opts.skipVehicleCheck) return result;

  // 9. Vehicle check.
  const cached = opts.protocol ?? 0;
  await send(`ATSP${cached.toString(16).toUpperCase()}`, { timeoutMs: 1000 });
  const pids = await send("0100", { timeoutMs: 10000 });
  if (pids.status === "unknown-command") {
    result.ok = false;
    result.failedStep = "vehicle-check";
    return result;
  }
  result.vehiclePresent = answersPids(pids);
  if (!result.vehiclePresent && cached !== 0 && wrongBus(pids.status)) {
    // Another car on this adapter (a K-line one after a CAN one): search, then back to the cached protocol for standby.
    opts.onSearch?.(true);
    result.foundProtocol = await searchProtocols(send);
    opts.onSearch?.(false);
    result.vehiclePresent = result.foundProtocol !== null;
    if (!result.vehiclePresent) await send(`ATSP${cached.toString(16).toUpperCase()}`, { timeoutMs: 1000 });
  }
  return result;
}

const answersPids = (r: ElmResponse) => r.status === "ok" && parseMode01(r.lines, 0x00, 4).length > 0;

/**
 * The cached protocol's bus isn't there: CAN frames nobody acknowledges, a K-line init nobody answers.
 * `NO DATA` is not one: the bus is there, the ECUs are asleep.
 */
export function wrongBus(status: ElmStatus): boolean {
  return status === "bus-error" || status === "unable-to-connect";
}

/**
 * Auto search (`ATSP0`) for whichever protocol answers `0100`; K-line inits make it take seconds (§8.1).
 * The protocol found (`ATDPN`; 0 if unreadable), null if none answered.
 */
export async function searchProtocols(send: Send): Promise<number | null> {
  await send("ATSP0", { timeoutMs: 1000 });
  if (!answersPids(await send("0100", { timeoutMs: 20000 }))) return null;
  return parseProtocolNumber((await send("ATDPN", { timeoutMs: 1000 })).lines) ?? 0;
}
