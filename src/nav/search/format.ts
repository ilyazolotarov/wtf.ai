// Search index file, format 1 (SEARCH-SPEC §4). Written by tools/tiles/tiles/search.py; keep
// both in step. Little-endian; sections start on 4-byte boundaries.

export const SEARCH_MAGIC = "WTFS";
export const SEARCH_FORMAT = 1;
export const HEADER_BYTES = 76;
export const ENTITY_BYTES = 44;
export const ADDRESS_BYTES = 12;
/** No string, parent or children. */
export const NONE = 0xffffffff;
/** Coordinates are integers in 1e-6°. */
export const COORD_SCALE = 1e-6;

export const EntityKind = { place: 1, street: 2, poi: 3 } as const;

export interface SearchHeader {
  entities: number;
  /** Entities 0 … settlements − 1 are the settlements: only they have children. */
  settlements: number;
  addresses: number;
  tokens: number;
  stringsAt: number;
  entitiesAt: number;
  addressesAt: number;
  tokenOffsetsAt: number;
  tokenBlobAt: number;
  postingStartsAt: number;
  postingsAt: number;
  osmDate: string;
  builtAt: number;
  size: number;
}

export function parseHeader(bytes: Uint8Array): SearchHeader {
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const v = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const format = v.getUint16(4, true);
  if (magic !== SEARCH_MAGIC || format !== SEARCH_FORMAT) {
    throw new Error(`not a format-${SEARCH_FORMAT} search file (${magic} ${format})`);
  }
  const u32 = (at: number) => v.getUint32(at, true);
  let osmDate = "";
  for (let i = 52; i < 68 && bytes[i] !== 0; i++) osmDate += String.fromCharCode(bytes[i]);
  return {
    entities: u32(8),
    settlements: u32(12),
    addresses: u32(16),
    tokens: u32(20),
    stringsAt: u32(24),
    entitiesAt: u32(28),
    addressesAt: u32(32),
    tokenOffsetsAt: u32(36),
    tokenBlobAt: u32(40),
    postingStartsAt: u32(44),
    postingsAt: u32(48),
    osmDate,
    builtAt: u32(68),
    size: u32(72),
  };
}

/** UTF-8 bytes to a string (names are short; no TextDecoder needed on Hermes). */
export function decodeUtf8(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
    else if (c < 0xf0) cp = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
    else cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}
