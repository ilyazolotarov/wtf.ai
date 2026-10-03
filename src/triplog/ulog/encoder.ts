// Streaming ULog v1 encoder. Formats must come before the first subscription/data
// message; the encoder enforces that. Info messages may also appear in the data section.

import { ByteWriter, utf8 } from "./bytes";
import {
  MSG,
  ULOG_MAGIC,
  ULOG_SYNC_MAGIC,
  ULOG_VERSION,
  formatString,
  payloadSize,
  type ULogFormat,
  type ULogType,
} from "./format";

export type FieldValue = number | boolean | string | readonly number[];

interface Subscription {
  id: number;
  format: ULogFormat;
  size: number;
}

export class ULogEncoder {
  private out = new ByteWriter();
  private formats = new Map<string, ULogFormat>();
  private subs = new Map<string, Subscription>();
  private definitionsDone = false;
  private nextId = 0;

  constructor(startTimestampUs: number) {
    ULOG_MAGIC.forEach((b) => this.out.u8(b));
    this.out.u8(ULOG_VERSION);
    this.out.u64(startTimestampUs);
    // Flag bits: 8 compat + 8 incompat + 3 × uint64 appended offsets, all zero.
    this.message(MSG.flagBits, () => {
      for (let i = 0; i < 16; i++) this.out.u8(0);
      for (let i = 0; i < 3; i++) this.out.u64(0);
    });
  }

  /** Bytes written so far and not yet taken. */
  get pendingBytes(): number {
    return this.out.length;
  }

  infoString(name: string, value: string): void {
    const bytes = utf8(value);
    this.info(`char[${bytes.length}] ${name}`, (w) => w.bytes(bytes));
  }

  infoUint32(name: string, value: number): void {
    this.info(`uint32_t ${name}`, (w) => w.u32(value));
  }

  infoInt64(name: string, value: number): void {
    this.info(`int64_t ${name}`, (w) => w.i64(value));
  }

  format(f: ULogFormat): void {
    this.requireDefinitions();
    if (f.fields[0]?.name !== "timestamp" || f.fields[0].type !== "uint64_t") {
      throw new Error(`format ${f.name}: first field must be uint64_t timestamp`);
    }
    this.formats.set(f.name, f);
    const text = utf8(formatString(f));
    this.message(MSG.format, () => this.out.bytes(text));
  }

  /** Add a logged message (subscription); ends the definitions section. */
  subscribe(name: string, multiId = 0): void {
    const format = this.formats.get(name);
    if (!format) throw new Error(`unknown format ${name}`);
    if (this.subs.has(name)) return;
    this.definitionsDone = true;
    const id = this.nextId++;
    this.subs.set(name, { id, format, size: payloadSize(format) });
    const text = utf8(name);
    this.message(MSG.addLogged, () => {
      this.out.u8(multiId);
      this.out.u16(id);
      this.out.bytes(text);
    });
  }

  /** Data message; `values` in field order, timestamp first. */
  data(name: string, values: readonly FieldValue[]): void {
    const sub = this.subs.get(name);
    if (!sub) throw new Error(`not subscribed: ${name}`);
    const fields = sub.format.fields;
    if (values.length !== fields.length) throw new Error(`${name}: expected ${fields.length} values`);
    this.message(MSG.data, () => {
      this.out.u16(sub.id);
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const v = values[i];
        if (f.count) {
          if (f.type === "char") {
            const bytes = utf8(String(v));
            for (let k = 0; k < f.count; k++) this.out.u8(bytes[k] ?? 0);
          } else {
            const arr = v as readonly number[];
            for (let k = 0; k < f.count; k++) this.scalar(f.type, arr[k] ?? 0);
          }
        } else {
          this.scalar(f.type, v as number | boolean);
        }
      }
    });
  }

  /** Tagged logged string ('C'). */
  tagged(level: number, tag: number, timestampUs: number, text: string): void {
    this.definitionsDone = true;
    const bytes = utf8(text.length > 4000 ? `${text.slice(0, 4000)}…` : text);
    this.message(MSG.loggingTagged, () => {
      this.out.u8(level);
      this.out.u16(tag);
      this.out.u64(timestampUs);
      this.out.bytes(bytes);
    });
  }

  sync(): void {
    this.message(MSG.sync, () => ULOG_SYNC_MAGIC.forEach((b) => this.out.u8(b)));
  }

  dropout(durationMs: number): void {
    this.message(MSG.dropout, () => this.out.u16(Math.min(0xffff, Math.max(0, Math.round(durationMs)))));
  }

  take(): Uint8Array {
    return this.out.take();
  }

  private info(key: string, writeValue: (w: ByteWriter) => void): void {
    const keyBytes = utf8(key);
    this.message(MSG.info, () => {
      this.out.u8(keyBytes.length);
      this.out.bytes(keyBytes);
      writeValue(this.out);
    });
  }

  private requireDefinitions(): void {
    if (this.definitionsDone) throw new Error("ULog definitions must precede data");
  }

  private message(type: number, body: () => void): void {
    const start = this.out.length;
    this.out.u16(0);
    this.out.u8(type);
    body();
    const size = this.out.length - start - 3;
    if (size > 0xffff) throw new Error("ULog message too large");
    this.out.patchU16(start, size);
  }

  private scalar(type: ULogType, v: number | boolean): void {
    const n = typeof v === "boolean" ? (v ? 1 : 0) : v;
    switch (type) {
      case "int8_t":
        return this.out.i8(n);
      case "uint8_t":
      case "bool":
      case "char":
        return this.out.u8(n);
      case "int16_t":
        return this.out.i16(n);
      case "uint16_t":
        return this.out.u16(n);
      case "int32_t":
        return this.out.i32(n);
      case "uint32_t":
        return this.out.u32(n);
      case "int64_t":
        return this.out.i64(n);
      case "uint64_t":
        return this.out.u64(n);
      case "float":
        return this.out.f32(n);
      case "double":
        return this.out.f64(n);
    }
  }
}
