// Signal layouts generated from opendbc DBCs (tools/can/profiles.ts → signals.json), and reading them from frame bytes.
// The bit walk is opendbc's (opendbc/can/dbc.py, Signal.get_raw_value), so a layout decodes here as it does there.

/** [start bit, size, little endian (1) or big endian (0), signed, factor, offset], as written in the DBC. */
export type SignalDef = [start: number, size: number, littleEndian: 0 | 1, signed: 0 | 1, factor: number, offset: number];

export interface MessageDef {
  id: number;
  /** DLC in the DBC. */
  size: number;
  sigs: Record<string, SignalDef>;
}

export interface DbcSignals {
  msgs: Record<string, MessageDef>;
  /** Value tables of the gear selectors that use them, "MSG.SIG" → value → label. */
  values?: Record<string, Record<string, string>>;
}

export interface SignalsFile {
  /** opendbc commit the layouts come from. */
  opendbc: string;
  dbcs: Record<string, DbcSignals>;
}

/** Big-endian bit order: the DBC numbers bits 7..0 of byte 0, then 15..8 of byte 1, ... */
const BE_BITS: number[] = [];
for (let i = 0; i < 64; i++) for (let j = 7; j >= 0; j--) BE_BITS.push(j + i * 8);

export interface Signal {
  msb: number;
  lsb: number;
  size: number;
  littleEndian: boolean;
  signed: boolean;
  factor: number;
  offset: number;
  /** Bytes the frame needs for this signal. */
  bytes: number;
}

export function signal([start, size, le, signed, factor, offset]: SignalDef): Signal {
  let msb: number;
  let lsb: number;
  if (le) {
    lsb = start;
    msb = start + size - 1;
  } else {
    msb = start;
    lsb = BE_BITS[BE_BITS.indexOf(start) + size - 1];
  }
  return {
    msb,
    lsb,
    size,
    littleEndian: le === 1,
    signed: signed === 1,
    factor,
    offset,
    bytes: Math.floor(Math.max(msb, lsb) / 8) + 1,
  };
}

/** The signal's value, or NaN when the frame is too short for it. */
export function readSignal(s: Signal, data: ArrayLike<number>, len = data.length): number {
  if (len < s.bytes) return NaN;
  let raw = 0;
  let i = Math.floor(s.msb / 8);
  let bits = s.size;
  while (i >= 0 && i < len && bits > 0) {
    const lsb = Math.floor(s.lsb / 8) === i ? s.lsb : i * 8;
    const msb = Math.floor(s.msb / 8) === i ? s.msb : (i + 1) * 8 - 1;
    const size = msb - lsb + 1;
    const d = (data[i] >> (lsb - i * 8)) & ((1 << size) - 1);
    // Multiplying, not shifting: signals can be up to 64 bits and JS shifts are 32-bit.
    raw += d * 2 ** (bits - size);
    bits -= size;
    i = s.littleEndian ? i - 1 : i + 1;
  }
  if (s.signed && raw >= 2 ** (s.size - 1)) raw -= 2 ** s.size;
  return raw * s.factor + s.offset;
}

/** Writes a value into frame bytes (rounded to the signal's step, clamped to its range): tests and the emulator. */
export function writeSignal(s: Signal, data: number[], value: number): void {
  let raw = Math.round((value - s.offset) / s.factor);
  const min = s.signed ? -(2 ** (s.size - 1)) : 0;
  const max = s.signed ? 2 ** (s.size - 1) - 1 : 2 ** s.size - 1;
  raw = Math.min(max, Math.max(min, raw));
  if (raw < 0) raw += 2 ** s.size;
  // Bit positions from the most significant to the least.
  const positions: number[] = [];
  if (s.littleEndian) for (let p = s.msb; p >= s.lsb; p--) positions.push(p);
  else for (let k = BE_BITS.indexOf(s.msb), n = 0; n < s.size; n++) positions.push(BE_BITS[k + n]);
  positions.forEach((p, n) => {
    const bit = Math.floor(raw / 2 ** (s.size - 1 - n)) % 2;
    const byte = p >> 3;
    while (data.length <= byte) data.push(0);
    data[byte] = bit ? data[byte] | (1 << (p & 7)) : data[byte] & ~(1 << (p & 7));
  });
}
