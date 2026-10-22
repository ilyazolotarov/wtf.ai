// Passive CAN monitor on STN adapters (docs/VEHICLE-LINK-SPEC.md §16): what the OBD port broadcasts.
// Pure TS: parses the adapter's monitor output (headers on) into frames and sums them up per CAN id.

export interface CanFrame {
  id: number;
  data: number[];
  /** Arrival of the chunk that ended the line (µs, the transport's clock). */
  rxUs: number;
}

export interface CanIdStats {
  id: number;
  count: number;
  /** Frames per monitored second. */
  hz: number;
  /** Data lengths seen. */
  lengths: number[];
  last: number[];
}

export interface CanSurvey {
  /** Hex digits of an id: 3 on 11-bit CAN, 8 on 29-bit. */
  idDigits: 3 | 8;
  /** Sorted by id. */
  ids: CanIdStats[];
  frames: number;
  durationMs: number;
  /** Characters received (transport load). */
  chars: number;
  /** `BUFFER FULL` lines: the adapter dropped frames. */
  bufferFull: number;
  /** Other lines that aren't frames (garbled lines). */
  other: number;
}

/** A slice of the id space: the ids whose top `bits` bits (of the 11 or 29) are `prefix`; bits 0: every id. */
export interface IdSlice {
  prefix: number;
  bits: number;
}

/** The pass filter (`STFPA id,mask`) of a slice on `width`-bit ids. */
export function sliceFilter(slice: IdSlice, width: 11 | 29): { id: number; mask: number } {
  const low = width - slice.bits;
  const mask = slice.bits === 0 ? 0 : ((2 ** slice.bits - 1) * 2 ** low) >>> 0;
  return { id: (slice.prefix * 2 ** low) >>> 0, mask };
}

/** Whether `id` is in the slice. */
export function inSlice(id: number, slice: IdSlice, width: 11 | 29): boolean {
  return Math.floor(id / 2 ** (width - slice.bits)) === slice.prefix;
}

const HEX = /^[0-9A-F]+$/;

/**
 * One monitor line, headers on, spaces on or off: an 11-bit id is 3 hex digits (`idDigits` 3), a 29-bit id 8.
 * Data length isn't printed (no `ATD1`): it is whatever follows the id, 0–8 bytes.
 */
export function parseMonitorLine(line: string, idDigits: 3 | 8): { id: number; data: number[] } | null {
  const s = line.replace(/\s+/g, "").toUpperCase();
  if (!HEX.test(s) || s.length < idDigits) return null;
  const rest = s.slice(idDigits);
  if (rest.length % 2 !== 0 || rest.length > 16) return null;
  const data: number[] = [];
  for (let i = 0; i < rest.length; i += 2) data.push(parseInt(rest.slice(i, i + 2), 16));
  return { id: parseInt(s.slice(0, idDigits), 16), data };
}

/** Collects monitor output arriving in arbitrary chunks (a line can span two). */
export class CanMonitorCollector {
  private partial = "";
  private byId = new Map<number, { count: number; lengths: Set<number>; last: number[] }>();
  private frames = 0;
  private chars = 0;
  private bufferFull = 0;
  private other = 0;

  constructor(
    private readonly idDigits: 3 | 8,
    private readonly onFrame?: (f: CanFrame) => void,
  ) {}

  push(text: string, rxUs: number): void {
    this.chars += text.length;
    const lines = (this.partial + text).split(/[\r\n]/);
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line, rxUs);
  }

  /** The output ended: a pending line counts (minus the prompt). */
  end(rxUs: number): void {
    const last = this.partial.replace(/>/g, "");
    this.partial = "";
    this.line(last, rxUs);
  }

  get frameCount(): number {
    return this.frames;
  }

  get bufferFullCount(): number {
    return this.bufferFull;
  }

  survey(durationMs: number): CanSurvey {
    const seconds = durationMs / 1000;
    const ids = [...this.byId.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, s]) => ({
        id,
        count: s.count,
        hz: seconds > 0 ? s.count / seconds : 0,
        lengths: [...s.lengths].sort((a, b) => a - b),
        last: s.last,
      }));
    return { idDigits: this.idDigits, ids, frames: this.frames, durationMs, chars: this.chars, bufferFull: this.bufferFull, other: this.other };
  }

  private line(raw: string, rxUs: number): void {
    const line = raw.trim();
    if (line === "" || line === "STOPPED") return;
    if (/BUFFER\s*FULL/i.test(line)) {
      this.bufferFull++;
      return;
    }
    const frame = parseMonitorLine(line, this.idDigits);
    if (!frame) {
      this.other++;
      return;
    }
    this.frames++;
    const s = this.byId.get(frame.id) ?? { count: 0, lengths: new Set<number>(), last: [] };
    s.count++;
    s.lengths.add(frame.data.length);
    s.last = frame.data;
    this.byId.set(frame.id, s);
    this.onFrame?.({ ...frame, rxUs });
  }
}

/** Ids as typed by a developer: hex, separated by spaces or commas (`215, 228 82`). Null: nothing usable. */
export function parseCanIds(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const ids: number[] = [];
  for (const p of parts) {
    const clean = p.replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
    ids.push(parseInt(clean, 16));
  }
  return [...new Set(ids)];
}

const hexId = (id: number, digits: number) => id.toString(16).toUpperCase().padStart(digits, "0");

/** A survey as text lines: the totals, then one line per id (for the terminal and the trip log). */
export function formatSurvey(s: CanSurvey): string[] {
  const seconds = s.durationMs / 1000;
  const perSecond = (n: number) => (seconds > 0 ? Math.round(n / seconds) : 0);
  const head =
    `${s.ids.length} ids, ${s.frames} frames in ${seconds.toFixed(1)} s ` +
    `(${perSecond(s.frames)}/s, ${perSecond(s.chars)} chars/s)` +
    (s.bufferFull > 0 ? `, BUFFER FULL ×${s.bufferFull}` : "") +
    (s.other > 0 ? `, ${s.other} other lines` : "");
  const rows = s.ids.map(
    (i) =>
      `${hexId(i.id, s.idDigits)} ${i.hz.toFixed(1).padStart(6)} Hz  ${i.lengths.join("/")} B  ` +
      i.last.map((b) => hexId(b, 2)).join(" "),
  );
  return [head, ...rows];
}
