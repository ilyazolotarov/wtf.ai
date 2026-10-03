// Streaming ZIP writer for exporting all trip logs as one file (TRIP-LOGGER-SPEC §7).
// Entries are stored, not deflated: ULog data compresses poorly and deflate in JS
// would take minutes on a large log set. CRC and sizes go in a data descriptor after
// each entry, so a file is read once, in chunks. No Zip64: entries and the archive
// stay below 4 GB.

import type { ByteSink } from "./trip-log-writer";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC), continuable: pass the previous result as `crc`. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** MS-DOS date/time in local time, as ZIP stores it. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const MAX_U32 = 0xffffffff;
const FLAGS = 0x0808; // bit 3: data descriptor follows; bit 11: UTF-8 names
const VERSION = 20;

interface Entry {
  name: Uint8Array;
  time: number;
  date: number;
  crc: number;
  size: number;
  offset: number;
}

export class ZipWriter {
  private entries: Entry[] = [];
  private offset = 0;

  constructor(private readonly sink: ByteSink) {}

  /** Adds one stored entry from a sequence of chunks. */
  addFile(name: string, modified: Date, chunks: Iterable<Uint8Array>): void {
    const nameBytes = new TextEncoder().encode(name);
    const { time, date } = dosDateTime(modified);
    const entry: Entry = { name: nameBytes, time, date, crc: 0, size: 0, offset: this.offset };

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, FLAGS, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    // CRC and sizes stay 0 here (bit 3); 14..29 also hold name length, extra length.
    local.setUint16(26, nameBytes.length, true);
    this.emit(new Uint8Array(local.buffer));
    this.emit(nameBytes);

    for (const chunk of chunks) {
      entry.crc = crc32(chunk, entry.crc);
      entry.size += chunk.length;
      this.emit(chunk);
    }
    if (entry.size > MAX_U32) throw new Error(`zip: ${name} is larger than 4 GB`);

    const descriptor = new DataView(new ArrayBuffer(16));
    descriptor.setUint32(0, 0x08074b50, true);
    descriptor.setUint32(4, entry.crc, true);
    descriptor.setUint32(8, entry.size, true);
    descriptor.setUint32(12, entry.size, true);
    this.emit(new Uint8Array(descriptor.buffer));
    this.entries.push(entry);
  }

  /** Writes the central directory and closes the sink. */
  finish(): void {
    const start = this.offset;
    for (const e of this.entries) {
      const header = new DataView(new ArrayBuffer(46));
      header.setUint32(0, 0x02014b50, true);
      header.setUint16(4, VERSION, true);
      header.setUint16(6, VERSION, true);
      header.setUint16(8, FLAGS, true);
      header.setUint16(10, 0, true);
      header.setUint16(12, e.time, true);
      header.setUint16(14, e.date, true);
      header.setUint32(16, e.crc, true);
      header.setUint32(20, e.size, true);
      header.setUint32(24, e.size, true);
      header.setUint16(28, e.name.length, true);
      // extra, comment, disk, internal/external attributes: 0
      header.setUint32(42, e.offset, true);
      this.emit(new Uint8Array(header.buffer));
      this.emit(e.name);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, this.offset - start, true);
    end.setUint32(16, start, true);
    this.emit(new Uint8Array(end.buffer));
    this.sink.close();
  }

  private emit(bytes: Uint8Array): void {
    if (this.offset + bytes.length > MAX_U32) throw new Error("zip: archive is larger than 4 GB");
    this.sink.write(bytes);
    this.offset += bytes.length;
  }
}
