// Verification on connect (docs/VEHICLE-LINK-SPEC.md §8.1).

import type { ElmResponse } from "../types";
import { parseElmVersion, parseMode01, parseVoltage } from "./parser";

type Send = (command: string, opts?: { timeoutMs?: number }) => Promise<ElmResponse>;

export interface ProbeResult {
  ok: boolean;
  /** Probe step that failed, for the dev UI. */
  failedStep?: string;
  elmVersion: string | null;
  description: string | null;
  chip: string | null;
  suspectedClone: boolean;
  batteryV: number | null;
  /** Vehicle answered `0100`. */
  vehiclePresent: boolean;
  warnings: string[];
}

const BANNER = /ELM|STN|OBDLINK/i;

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
}

export async function probeAdapter(send: Send, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const result: ProbeResult = {
    ok: false,
    elmVersion: null,
    description: null,
    chip: null,
    suspectedClone: false,
    batteryV: null,
    vehiclePresent: false,
    warnings: [],
  };

  // 2. Flush half-typed input; some clones drop the first command after connect.
  await send("", { timeoutMs: 1000 });

  // 3. Reset.
  let reset = await send("ATZ", { timeoutMs: 3000 });
  if (reset.status === "timeout" || !BANNER.test(text(reset))) {
    reset = await send("ATWS", { timeoutMs: 3000 });
  }
  if (reset.status === "timeout" || !BANNER.test(text(reset))) {
    // Some adapters answer ATZ with a bare prompt; accept if ATI identifies them.
    const ati = await send("ATI", { timeoutMs: 1000 });
    if (ati.status !== "ok" || !BANNER.test(text(ati))) {
      result.failedStep = "reset";
      return result;
    }
    reset = ati;
  }
  result.elmVersion = parseElmVersion(reset.lines);

  // 4. Echo off.
  const echo = await send("ATE0", { timeoutMs: 1000 });
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
  await send(`ATSP${(opts.protocol ?? 0).toString(16).toUpperCase()}`, { timeoutMs: 1000 });
  const pids = await send("0100", { timeoutMs: 10000 });
  if (pids.status === "unknown-command") {
    result.ok = false;
    result.failedStep = "vehicle-check";
    return result;
  }
  result.vehiclePresent = pids.status === "ok" && parseMode01(pids.lines, 0x00, 4).length > 0;
  return result;
}
