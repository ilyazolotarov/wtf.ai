// ELM327 response parsing (docs/VEHICLE-LINK-SPEC.md §8.3). Tolerant of clone quirks:
// echo, NULs, any CR/LF mix, lowercase hex, spaces on/off, headers on/off.

import type { ElmStatus } from "../types";

export interface ParsedResponse {
  status: ElmStatus;
  lines: string[];
}

const NOISE = [/^SEARCHING\.*$/i, /^BUS INIT:?\s*\.*\s*(OK)?$/i];

const ERRORS: readonly [RegExp, ElmStatus][] = [
  [/^NO DATA$/i, "no-data"],
  [/UNABLE TO CONNECT/i, "unable-to-connect"],
  [/^STOPPED$/i, "stopped"],
  [/^BUFFER FULL$/i, "buffer-full"],
  [/^\?$/, "unknown-command"],
  [
    /CAN ERROR|BUS ERROR|BUS BUSY|FB ERROR|DATA ERROR|<RX ERROR|^ERR\d\d|BUS INIT:.*ERROR|^LV RESET$|^ACT ALERT$/i,
    "bus-error",
  ],
];

const compact = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export function splitLines(raw: string): string[] {
  return raw
    .replace(/\0/g, "")
    .split(/[\r\n]+/)
    .map((line) => line.replace(/>/g, "").trim())
    .filter((line) => line.length > 0);
}

export function parseResponse(command: string, raw: string): ParsedResponse {
  let lines = splitLines(raw);
  const cmd = compact(command);
  if (cmd.length > 0 && lines.length > 0 && compact(lines[0]) === cmd) {
    lines = lines.slice(1);
  }
  lines = lines.filter((line) => !NOISE.some((re) => re.test(line)));

  const errors: ElmStatus[] = [];
  const data: string[] = [];
  for (const line of lines) {
    const hit = ERRORS.find(([re]) => re.test(line));
    if (hit) errors.push(hit[1]);
    else data.push(line);
  }
  if (data.length === 0 && errors.length > 0) {
    return { status: errors[0], lines };
  }
  return { status: "ok", lines: data };
}

export interface Mode01Answer {
  /** Responding ECU (CAN id or ISO source address), null when headers are off. */
  ecu: number | null;
  bytes: number[];
}

/** Header layouts to try: [header hex chars, ecu slice]. */
const HEADER_LAYOUTS: readonly { skip: number; ecu: (h: string) => number | null }[] = [
  { skip: 0, ecu: () => null }, // headers off
  { skip: 5, ecu: (h) => parseInt(h.slice(0, 3), 16) }, // 11-bit CAN: 7E8 + PCI
  { skip: 10, ecu: (h) => parseInt(h.slice(0, 8), 16) }, // 29-bit CAN: 18DAF110 + PCI
  { skip: 6, ecu: (h) => parseInt(h.slice(4, 6), 16) }, // J1850/ISO: 3 header bytes, source last
];

/**
 * Find Mode 01 answers for `pid` with `count` data bytes. Returns one entry per
 * responding ECU line. Non-CAN checksum bytes after the data are ignored.
 */
export function parseMode01(lines: string[], pid: number, count: number): Mode01Answer[] {
  const marker = "41" + pid.toString(16).toUpperCase().padStart(2, "0");
  const answers: Mode01Answer[] = [];
  for (const line of lines) {
    const hex = compact(line);
    if (!/^[0-9A-F]+$/.test(hex)) continue;
    for (const layout of HEADER_LAYOUTS) {
      if (hex.length < layout.skip + 4 + count * 2) continue;
      if (hex.slice(layout.skip, layout.skip + 4) !== marker) continue;
      const dataHex = hex.slice(layout.skip + 4, layout.skip + 4 + count * 2);
      const bytes: number[] = [];
      for (let i = 0; i < dataHex.length; i += 2) bytes.push(parseInt(dataHex.slice(i, i + 2), 16));
      answers.push({ ecu: layout.ecu(hex.slice(0, layout.skip)), bytes });
      break;
    }
  }
  return answers;
}

/**
 * CAN frames as they come with headers on (`ATH1`, which the CAN monitor leaves set while polling): `7E8 10 14 49 02
 * 01 …`, `7E8 21 …` (11-bit) or `18DAF110 10 14 …` (29-bit). Each sender's ISO-TP payloads joined, in order; null
 * when the lines aren't such frames.
 */
function headerFramePayloads(lines: string[]): string[] | null {
  const bySender = new Map<string, string>();
  for (const line of lines) {
    const m = /^(7E[89A-F]|18DAF1[0-9A-F]{2})((?:[0-9A-F]{2})+)$/i.exec(compact(line));
    if (!m) return null;
    const pci = parseInt(m[2][0], 16);
    // Single (0) and consecutive (2) frames: one PCI byte; a first frame (1): two, the length after the type.
    const payload = pci === 1 ? m[2].slice(4) : m[2].slice(2);
    bySender.set(m[1], (bySender.get(m[1]) ?? "") + payload);
  }
  return bySender.size > 0 ? [...bySender.values()] : null;
}

/**
 * A CAN multi-frame line: the frame index, a colon, its bytes. Some clones put the byte count on the first frame's
 * line instead of its own (`0140: 49 02 01 …`, seen on an ELM327 v1.5 clone over 29-bit CAN).
 */
const FRAME_LINE = /^(?:[0-9A-F]{3}\s*)?[0-9A-F]\s*:/i;

/** VIN from a `0902` answer: CAN multi-frame ("0: 4902…"), CAN frames with headers, or ISO/J1850 line-per-frame. */
export function parseVin(lines: string[]): string | null {
  let hex = "";
  const framed = lines.filter((l) => FRAME_LINE.test(l.trim()));
  const withHeaders = framed.length > 0 ? null : headerFramePayloads(lines);
  if (withHeaders) {
    const payload = withHeaders.find((p) => p.toUpperCase().includes("4902"));
    if (!payload) return null;
    hex = payload.slice(payload.toUpperCase().indexOf("4902") + 6); // skip 49 02 + message count
  } else if (framed.length > 0) {
    const joined = framed.map((l) => compact(l.slice(l.indexOf(":") + 1))).join("");
    const at = joined.indexOf("4902");
    if (at < 0) return null;
    hex = joined.slice(at + 6); // skip 49 02 + message count
  } else {
    for (const line of lines) {
      const h = compact(line);
      const at = h.indexOf("4902");
      if (at >= 0) hex += h.slice(at + 6);
    }
  }
  let text = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) text += String.fromCharCode(code);
  }
  return text.length >= 17 ? text.slice(-17) : null;
}

/** "ELM327 v1.5" from ATZ/ATI text. */
export function parseElmVersion(lines: string[]): string | null {
  for (const line of lines) {
    const m = /ELM\s*327\s*v?\s*([0-9]+(?:\.[0-9a-z]+)?)/i.exec(line);
    if (m) return `ELM327 v${m[1]}`;
  }
  return null;
}

/** Battery voltage from ATRV ("12.6V"). */
export function parseVoltage(lines: string[]): number | null {
  for (const line of lines) {
    const m = /([0-9]{1,2}(?:\.[0-9]+)?)\s*V/i.exec(line);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/** Protocol number from ATDPN ("A6" → 6, "7" → 7, "AA" → 10). */
export function parseProtocolNumber(lines: string[]): number | null {
  const m = /^A?([0-9A-C])$/i.exec(compact(lines[0] ?? ""));
  return m ? parseInt(m[1], 16) : null;
}

/** Responding ECU addresses from header-on Mode 01 answers. */
export function respondingEcus(answers: Mode01Answer[]): number[] {
  return [...new Set(answers.map((a) => a.ecu).filter((e): e is number => e !== null))];
}
