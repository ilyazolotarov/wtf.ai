// Minimal ULog v1 reader (tests and the future replay harness). Tolerates a
// truncated last message, like pyulog.

import { ByteReader, utf8Decode } from "./bytes";
import { MSG, ULOG_MAGIC, parseFormatString, type ULogFormat, type ULogType } from "./format";

export type RecordValue = number | string | number[];
export type ULogRecord = Record<string, RecordValue>;

export interface ULogLogMessage {
  level: number;
  tag: number | null;
  timestampUs: number;
  text: string;
}

export interface ULogFile {
  version: number;
  startUs: number;
  info: Record<string, RecordValue>;
  formats: Record<string, ULogFormat>;
  data: Record<string, ULogRecord[]>;
  logs: ULogLogMessage[];
  dropoutsMs: number[];
  syncCount: number;
  truncated: boolean;
}

function readScalar(r: ByteReader, type: ULogType): number {
  switch (type) {
    case "int8_t":
      return r.i8();
    case "uint8_t":
    case "bool":
    case "char":
      return r.u8();
    case "int16_t":
      return r.i16();
    case "uint16_t":
      return r.u16();
    case "int32_t":
      return r.i32();
    case "uint32_t":
      return r.u32();
    case "int64_t":
      return r.i64();
    case "uint64_t":
      return r.u64();
    case "float":
      return r.f32();
    case "double":
      return r.f64();
  }
}

function readTyped(r: ByteReader, type: ULogType, count: number | undefined): RecordValue {
  if (type === "char" && count !== undefined) {
    const bytes = r.bytes(count);
    const end = bytes.indexOf(0);
    return utf8Decode(end >= 0 ? bytes.subarray(0, end) : bytes);
  }
  if (count === undefined) return readScalar(r, type);
  const arr: number[] = [];
  for (let i = 0; i < count; i++) arr.push(readScalar(r, type));
  return arr;
}

export function readULog(buf: Uint8Array): ULogFile {
  const r = new ByteReader(buf);
  for (const b of ULOG_MAGIC) if (r.u8() !== b) throw new Error("not a ULog file");
  const file: ULogFile = {
    version: r.u8(),
    startUs: r.u64(),
    info: {},
    formats: {},
    data: {},
    logs: [],
    dropoutsMs: [],
    syncCount: 0,
    truncated: false,
  };
  const subs = new Map<number, ULogFormat>();

  while (r.remaining >= 3) {
    const size = r.u16();
    const type = r.u8();
    if (r.remaining < size) {
      file.truncated = true;
      break;
    }
    const body = new ByteReader(r.bytes(size));
    switch (type) {
      case MSG.format: {
        const f = parseFormatString(utf8Decode(body.bytes(size)));
        file.formats[f.name] = f;
        break;
      }
      case MSG.info: {
        const keyLen = body.u8();
        const key = utf8Decode(body.bytes(keyLen));
        const m = /^([a-z0-9_]+)(?:\[(\d+)\])?\s+(.+)$/.exec(key);
        if (!m) break;
        file.info[m[3]] = readTyped(body, m[1] as ULogType, m[2] ? parseInt(m[2], 10) : undefined);
        break;
      }
      case MSG.addLogged: {
        body.u8();
        const id = body.u16();
        const name = utf8Decode(body.bytes(size - 3));
        const f = file.formats[name];
        if (f) {
          subs.set(id, f);
          file.data[name] ??= [];
        }
        break;
      }
      case MSG.data: {
        const f = subs.get(body.u16());
        if (!f) break;
        const rec: ULogRecord = {};
        for (const field of f.fields) rec[field.name] = readTyped(body, field.type, field.count);
        file.data[f.name].push(rec);
        break;
      }
      case MSG.logging: {
        const level = body.u8();
        const timestampUs = body.u64();
        file.logs.push({ level, tag: null, timestampUs, text: utf8Decode(body.bytes(size - 9)) });
        break;
      }
      case MSG.loggingTagged: {
        const level = body.u8();
        const tag = body.u16();
        const timestampUs = body.u64();
        file.logs.push({ level, tag, timestampUs, text: utf8Decode(body.bytes(size - 11)) });
        break;
      }
      case MSG.sync:
        file.syncCount++;
        break;
      case MSG.dropout:
        file.dropoutsMs.push(body.u16());
        break;
      default:
        break;
    }
  }
  if (r.remaining > 0) file.truncated = true;
  return file;
}
