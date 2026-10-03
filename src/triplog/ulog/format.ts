// ULog v1 constants and format definitions (https://docs.px4.io/main/en/dev_log/ulog_file_format.html).

export const ULOG_MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35] as const;
export const ULOG_VERSION = 1;
export const ULOG_SYNC_MAGIC = [0x2f, 0x73, 0x13, 0x20, 0x25, 0x0c, 0xbb, 0x12] as const;

export const MSG = {
  flagBits: "B".charCodeAt(0),
  format: "F".charCodeAt(0),
  info: "I".charCodeAt(0),
  infoMulti: "M".charCodeAt(0),
  parameter: "P".charCodeAt(0),
  addLogged: "A".charCodeAt(0),
  removeLogged: "R".charCodeAt(0),
  data: "D".charCodeAt(0),
  logging: "L".charCodeAt(0),
  loggingTagged: "C".charCodeAt(0),
  sync: "S".charCodeAt(0),
  dropout: "O".charCodeAt(0),
} as const;

export type ULogType =
  | "int8_t"
  | "uint8_t"
  | "int16_t"
  | "uint16_t"
  | "int32_t"
  | "uint32_t"
  | "int64_t"
  | "uint64_t"
  | "float"
  | "double"
  | "bool"
  | "char";

export const TYPE_SIZE: Record<ULogType, number> = {
  int8_t: 1,
  uint8_t: 1,
  int16_t: 2,
  uint16_t: 2,
  int32_t: 4,
  uint32_t: 4,
  int64_t: 8,
  uint64_t: 8,
  float: 4,
  double: 8,
  bool: 1,
  char: 1,
};

export interface ULogField {
  type: ULogType;
  name: string;
  /** Array length; omitted for scalars. */
  count?: number;
}

export interface ULogFormat {
  name: string;
  /** First field must be `uint64_t timestamp` for logged (subscribed) messages. */
  fields: ULogField[];
}

export const LOG_LEVEL = {
  error: "3".charCodeAt(0),
  warning: "4".charCodeAt(0),
  info: "6".charCodeAt(0),
  debug: "7".charCodeAt(0),
} as const;

export function formatString(f: ULogFormat): string {
  return `${f.name}:${f.fields.map((x) => `${x.type}${x.count ? `[${x.count}]` : ""} ${x.name};`).join("")}`;
}

export function payloadSize(f: ULogFormat): number {
  return f.fields.reduce((n, x) => n + TYPE_SIZE[x.type] * (x.count ?? 1), 0);
}

export function parseFormatString(s: string): ULogFormat {
  const colon = s.indexOf(":");
  const name = s.slice(0, colon);
  const fields = s
    .slice(colon + 1)
    .split(";")
    .filter((f) => f.trim().length > 0)
    .map((f) => {
      const [typePart, fieldName] = f.trim().split(/\s+/);
      const m = /^([a-z0-9_]+)(?:\[(\d+)\])?$/.exec(typePart)!;
      return { type: m[1] as ULogType, name: fieldName, count: m[2] ? parseInt(m[2], 10) : undefined };
    });
  return { name, fields };
}
