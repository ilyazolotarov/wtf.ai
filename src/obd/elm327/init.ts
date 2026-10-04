// Session init once the vehicle answers (docs/VEHICLE-LINK-SPEC.md §9).

import { decodeSupportedPids, PID_RPM, PID_SPEED } from "../pids";
import type { AdapterCapabilities, ElmResponse, VehicleInfo } from "../types";
import { parseMode01, parseProtocolNumber, parseVin, respondingEcus } from "./parser";

type Send = (command: string, opts?: { timeoutMs?: number }) => Promise<ElmResponse>;

export interface PollConfig {
  speedCommand: string;
  rpmCommand: string;
}

export interface InitResult {
  ok: boolean;
  error?: "no-vehicle" | "no-speed-pid";
  vehicle: VehicleInfo;
  protocolNumber: number | null;
  capabilities: AdapterCapabilities;
  poll: PollConfig;
}

export interface InitOptions {
  cachedProtocol?: number | null;
  /** Polls per measurement in the speed-up probes. */
  probePolls?: number;
}

const hex = (n: number) => n.toString(16).toUpperCase();

/** 11-bit CAN response id of the engine ECU, which holds the VIN (mode 09). */
const ENGINE_ECU = 0x7e8;

/**
 * VIN (non-fatal). Mode 09 is the engine ECU's; the ECU pinned for speed may be another one (on a
 * CX-5 the TCM at 7E9 answers 0902 with 7F 09 12). With another ECU pinned, ask the engine ECU,
 * then pin the speed ECU again; the pinned one is the fallback.
 */
async function readVin(send: Send, pinned: number | null): Promise<string | null> {
  const ask = async () => {
    const r = await send("0902", { timeoutMs: 5000 });
    return r.status === "ok" ? parseVin(r.lines) : null;
  };
  if (pinned === null || pinned === ENGINE_ECU) return ask();
  let vin: string | null = null;
  const sh = await send(`ATSH${hex(ENGINE_ECU - 8)}`, { timeoutMs: 1000 });
  if (sh.status === "ok" && (await send(`ATCRA${hex(ENGINE_ECU)}`, { timeoutMs: 1000 })).status === "ok") vin = await ask();
  await send(`ATSH${hex(pinned - 8)}`, { timeoutMs: 1000 });
  await send(`ATCRA${hex(pinned)}`, { timeoutMs: 1000 });
  return vin ?? ask();
}

interface Measurement {
  ok: boolean;
  latencyMs: number;
}

/**
 * Median latency over `polls` requests. One failure is tolerated: a single adapter stall
 * shouldn't lock in a slower command for the whole session; an unsupported one fails them all.
 */
async function measure(send: Send, command: string, polls: number): Promise<Measurement> {
  const latencies: number[] = [];
  let failures = 0;
  for (let i = 0; i < polls; i++) {
    const r = await send(command, { timeoutMs: 1000 });
    if (r.status !== "ok" || parseMode01(r.lines, PID_SPEED, 1).length === 0) {
      if (++failures > 1 || failures === polls) return { ok: false, latencyMs: Infinity };
      continue;
    }
    latencies.push((r.rxUs - r.txUs) / 1000);
  }
  latencies.sort((a, b) => a - b);
  const mid = latencies.length >> 1;
  const median = latencies.length % 2 ? latencies[mid] : (latencies[mid - 1] + latencies[mid]) / 2;
  return { ok: true, latencyMs: median };
}

export async function initVehicle(send: Send, opts: InitOptions = {}): Promise<InitResult> {
  const polls = opts.probePolls ?? 10;
  const capabilities: AdapterCapabilities = {
    responseCount: false,
    adaptiveTiming2: false,
    physicalAddressing: false,
  };
  const vehicle: VehicleInfo = { protocol: null, supportedPids01: [], vin: null, speedEcu: null };
  const fail = (error: InitResult["error"]): InitResult => ({
    ok: false,
    error,
    vehicle,
    protocolNumber: null,
    capabilities,
    poll: { speedCommand: "010D", rpmCommand: "010C" },
  });

  // Retry once without an OK: a late reply (e.g. a reset banner) means the command was lost.
  for (const c of ["ATE0", "ATL0", "ATS0", "ATH1", "ATAT1"]) {
    const r = await send(c, { timeoutMs: 1000 });
    if (!/\bOK\b/.test(r.lines.join(" "))) await send(c, { timeoutMs: 1000 });
  }

  // 1. Protocol: auto search (or cached), then lock it.
  const cached = opts.cachedProtocol ?? 0;
  await send(`ATSP${hex(cached)}`, { timeoutMs: 1000 });
  let supported = await send("0100", { timeoutMs: 10000 });
  if (supported.status !== "ok" && cached !== 0) {
    await send("ATSP0", { timeoutMs: 1000 });
    supported = await send("0100", { timeoutMs: 10000 });
  }
  const bitmaps = parseMode01(supported.lines, 0x00, 4);
  if (supported.status !== "ok" || bitmaps.length === 0) return fail("no-vehicle");

  const dpn = await send("ATDPN", { timeoutMs: 1000 });
  const protocolNumber = parseProtocolNumber(dpn.lines);
  vehicle.protocol = dpn.lines[0] ?? null;
  if (protocolNumber !== null && protocolNumber !== 0) await send(`ATSP${hex(protocolNumber)}`, { timeoutMs: 1000 });

  // 2. Supported PIDs (union over ECUs).
  const pids = new Set<string>();
  for (const b of bitmaps) decodeSupportedPids(0x00, b.bytes).forEach((p) => pids.add(p));
  vehicle.supportedPids01 = [...pids].sort();
  if (!pids.has("0D")) return fail("no-speed-pid");

  // 3. Pin the speed ECU (11-bit CAN only).
  let pinned: number | null = null;
  const speedProbe = await send("010D", { timeoutMs: 2000 });
  const ecus = respondingEcus(parseMode01(speedProbe.lines, PID_SPEED, 1));
  const chosen = ecus.includes(ENGINE_ECU) ? ENGINE_ECU : ecus[0];
  if (chosen !== undefined) vehicle.speedEcu = hex(chosen);
  if ((protocolNumber === 6 || protocolNumber === 8) && chosen !== undefined && chosen >= 0x7e8 && chosen <= 0x7ef) {
    const sh = await send(`ATSH${hex(chosen - 8)}`, { timeoutMs: 1000 });
    const cra = sh.status === "ok" ? await send(`ATCRA${hex(chosen)}`, { timeoutMs: 1000 }) : sh;
    const check = cra.status === "ok" ? await send("010D", { timeoutMs: 2000 }) : cra;
    if (check.status === "ok" && parseMode01(check.lines, PID_SPEED, 1).length > 0) {
      capabilities.physicalAddressing = true;
      pinned = chosen;
    } else {
      await send("ATSH7DF", { timeoutMs: 1000 });
      await send("ATAR", { timeoutMs: 1000 });
    }
  }
  await send("ATH0", { timeoutMs: 1000 });

  vehicle.vin = await readVin(send, pinned);

  // 4. Speed-up probes (§9.3).
  const plain = await measure(send, "010D", polls);
  const counted = await measure(send, "010D1", polls);
  capabilities.responseCount = counted.ok && counted.latencyMs <= plain.latencyMs * 1.05;
  const speedCommand = capabilities.responseCount ? "010D1" : "010D";
  const baseline = capabilities.responseCount ? counted : plain;

  const at2 = await send("ATAT2", { timeoutMs: 1000 });
  if (at2.status === "ok") {
    const fast = await measure(send, speedCommand, polls);
    capabilities.adaptiveTiming2 = fast.ok && fast.latencyMs <= baseline.latencyMs;
    if (!capabilities.adaptiveTiming2) await send("ATAT1", { timeoutMs: 1000 });
  }

  let rpmCommand = "010C";
  if (capabilities.responseCount && pids.has("0C")) {
    const r = await send("010C1", { timeoutMs: 1000 });
    if (r.status === "ok" && parseMode01(r.lines, PID_RPM, 2).length > 0) rpmCommand = "010C1";
  }

  return { ok: true, vehicle, protocolNumber, capabilities, poll: { speedCommand, rpmCommand } };
}
