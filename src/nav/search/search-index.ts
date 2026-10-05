// Offline address search (SEARCH-SPEC §5): queries a region's `<region>.search.bin` by random
// access. Synchronous and small: a query reads a few posting lists, the entities that match
// and a street's house numbers, well under the time of a keystroke on the JS thread.

import { haversineM, type Coordinate } from "@/nav/geo";
import type { ByteSource } from "@/nav/mapmatch/graph/byte-source";
import { fold, foldHouse, parseQuery, STOPWORDS, type QueryToken } from "@/nav/search/fold";
import {
  ADDRESS_BYTES,
  COORD_SCALE,
  decodeUtf8,
  ENTITY_BYTES,
  EntityKind,
  HEADER_BYTES,
  NONE,
  parseHeader,
  type SearchHeader,
} from "@/nav/search/format";

export type SearchResultKind = "place" | "street" | "poi" | "address";

export interface SearchResult {
  /** Stable within one file: `e<entity>` or `a<address>`. */
  key: string;
  kind: SearchResultKind;
  /** Place, street or POI name; for an address its street's (or settlement's) name. */
  name: string;
  nameEn: string | null;
  /** Address only, as mapped ("10А"). */
  house: string | null;
  /** OSM tag that made it: "place=village", "highway=residential", "amenity=fuel", "addr:street" (a street known only from its houses). */
  tag: string;
  /** The settlement it belongs to (none for a settlement itself, or far from any). */
  settlement: { name: string; nameEn: string | null } | null;
  lat: number;
  lon: number;
  score: number;
}

export interface SearchOptions {
  /** Ranks nearer results higher (the car's position). */
  near?: Coordinate | null;
  limit?: number;
}

interface Entity {
  id: number;
  kind: number;
  rank: number;
  lat: number;
  lon: number;
  /** String offsets: decoded only for the entities that are scored in full. */
  nameAt: number;
  nameEnAt: number;
  tagAt: number;
  parent: number;
  addr: number;
  naddr: number;
  child: number;
  nchild: number;
}

interface TokenSet {
  token: QueryToken;
  /** Entities whose own names have the token (sorted). */
  ids: Uint32Array;
  /** Children of the settlements among `ids`: [start, end) sorted by start. */
  ranges: [number, number][];
  cost: number;
}

interface House {
  /** Index in the file's address table. */
  index: number;
  house: string;
  lat: number;
  lon: number;
  /** Score added for the number: exact or a start of it. */
  bonus: number;
}

interface Match {
  id: number;
  /** Bit i: token i matched the entity's own names / its settlement's. */
  direct: number;
  via: number;
}

/** Postings read for one query word at most (a two-letter prefix in the whole country). */
const MAX_POSTINGS = 60_000;
/** Entities matched per query at most; all get a cheap score from ids, rank and distance … */
const MAX_MATCHES = 3_000;
/** … and the best this many a full one, by their names (decoded and folded). */
const FULL_SCORED = 250;
/** Streets (and settlements) whose house numbers are read, with a number in the query. */
const HOUSE_OWNERS = 60;
/** Entities read from the file at once. */
const ENTITY_BLOCK = 32;
const MAX_TOKENS = 8;
/** Address results per street. */
const HOUSES_PER_STREET = 5;
const CACHE_LIMIT = 20_000;

const toU32 = (bytes: Uint8Array) => {
  const copy = bytes.slice();
  return new Uint32Array(copy.buffer, 0, copy.byteLength >> 2);
};

function bits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

function contains(ids: Uint32Array, id: number): boolean {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  return lo < ids.length && ids[lo] === id;
}

function inRanges(ranges: [number, number][], id: number): boolean {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid][1] <= id) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo][0] <= id;
}

export class SearchIndex {
  readonly header: SearchHeader;
  private tokenOffsets: Uint32Array | null = null;
  private tokenBlob: Uint8Array | null = null;
  private postingStarts: Uint32Array | null = null;
  private readonly entities = new Map<number, Entity>();
  private readonly entityBlocks = new Map<number, DataView>();
  private readonly strings = new Map<number, string>();

  constructor(private readonly source: ByteSource) {
    this.header = parseHeader(source.read(0, HEADER_BYTES));
    if (this.header.size !== source.size) {
      throw new Error(`search file is ${source.size} bytes, header says ${this.header.size}`);
    }
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 20;
    const parsed = parseQuery(query);
    const tokens = parsed.tokens.slice(0, MAX_TOKENS);
    const best = new Map<string, SearchResult>();
    const keep = (results: SearchResult[]) => {
      for (const r of results) {
        const had = best.get(r.key);
        if (!had || had.score < r.score) best.set(r.key, r);
      }
    };
    // With a house number: its street without it; and every word as a name ("8 Березня").
    if (parsed.house) {
      keep(this.run(tokens.filter((t) => !t.house), parsed.house, options.near ?? null));
    }
    keep(this.run(tokens, null, options.near ?? null));
    if (this.entities.size > CACHE_LIMIT) {
      this.entities.clear();
      this.entityBlocks.clear();
    }
    if (this.strings.size > CACHE_LIMIT) this.strings.clear();
    return [...best.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  private run(tokens: QueryToken[], house: string | null, near: Coordinate | null): SearchResult[] {
    // Street kinds ("вул.", "вули…" while typing) and single letters never decide a match.
    const use = tokens.filter((t) => !t.optional);
    if (use.length === 0) return [];
    let ranked = this.match(use).map((m) => {
      const e = this.entity(m.id);
      return { m, e, coarse: this.coarseScore(e, m, near) };
    });
    if (house) ranked = ranked.filter(({ e }) => e.naddr > 0 || e.kind === EntityKind.street);
    ranked.sort((a, b) => b.coarse - a.coarse);
    const out: SearchResult[] = [];
    for (const { m, e } of ranked.slice(0, house ? HOUSE_OWNERS : FULL_SCORED)) {
      const score = this.score(e, m, use, tokens, near);
      if (house) {
        const houses = this.houses(e, house);
        for (const h of houses) out.push(this.addressResult(e, h, score + h.bonus, near));
        // The street itself, below its houses: the number may be unmapped.
        if (e.kind === EntityKind.street) out.push(this.result(e, score - 4));
      } else {
        out.push(this.result(e, score));
      }
    }
    return out;
  }

  /** Entities that every token matches, by its own names or its settlement's (at least one its own). */
  private match(tokens: QueryToken[]): Match[] {
    const sets: TokenSet[] = [];
    for (const token of tokens) {
      const ids = this.postings(token);
      const ranges: [number, number][] = [];
      let cost = ids.length;
      for (const id of ids) {
        if (id >= this.header.settlements) break;
        const e = this.entity(id);
        if (e.nchild > 0) {
          ranges.push([e.child, e.child + e.nchild]);
          cost += e.nchild;
        }
      }
      if (cost === 0) return [];
      ranges.sort((a, b) => a[0] - b[0]);
      sets.push({ token, ids, ranges, cost });
    }
    const driver = sets.reduce((a, b) => (b.cost < a.cost ? b : a));
    const out: Match[] = [];
    const seen = new Set<number>();
    const test = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      let direct = 0;
      let via = 0;
      for (let i = 0; i < sets.length; i++) {
        if (contains(sets[i].ids, id)) direct |= 1 << i;
        else if (inRanges(sets[i].ranges, id)) via |= 1 << i;
        else return;
      }
      if (direct !== 0) out.push({ id, direct, via });
    };
    for (const id of driver.ids) {
      test(id);
      if (out.length >= MAX_MATCHES) return out;
    }
    for (const [start, end] of driver.ranges) {
      for (let id = start; id < end; id++) {
        test(id);
        if (out.length >= MAX_MATCHES) return out;
      }
    }
    return out;
  }

  /** From what the ids and the record tell, before any name is decoded. */
  private coarseScore(e: Entity, m: Match, near: Coordinate | null): number {
    let score = 8 * bits(m.direct) + 5 * bits(m.via) + this.kindScore(e);
    if (near) score -= 7 * Math.log10(1 + haversineM(near, e) / 1000);
    return score;
  }

  private kindScore(e: Entity): number {
    if (e.kind === EntityKind.place) return 4 + (e.rank / 65_535) * 24;
    if (e.kind === EntityKind.street) return 6 + (Math.min(e.rank, 30_000) / 30_000) * 4;
    return 3;
  }

  private score(e: Entity, m: Match, use: QueryToken[], all: QueryToken[], near: Coordinate | null): number {
    const name = this.string(e.nameAt);
    const nameEn = e.nameEnAt === NONE ? null : this.string(e.nameEnAt);
    const words = new Set([...fold(name), ...(nameEn ? fold(nameEn) : [])]);
    let score = 0;
    use.forEach((t, i) => {
      if (m.direct & (1 << i)) {
        if (words.has(t.text)) score += 10;
        else if (t.prefix && [...words].some((w) => w.startsWith(t.text))) score += 7;
        else score += 6; // another of its names (old, Russian, alternative)
      } else {
        score += 5;
      }
    });
    // Words of its name the query left out; the whole name typed scores more.
    const typed = (w: string) => all.some((t) => t.text === w || (t.prefix && w.startsWith(t.text)));
    const missing = fold(name).filter((w) => !STOPWORDS.has(w) && !typed(w)).length;
    score += missing === 0 ? 6 : -0.5 * missing;
    score += this.kindScore(e);
    if (near) score -= 7 * Math.log10(1 + haversineM(near, e) / 1000);
    return score;
  }

  /** House numbers of a street (or a settlement's `addr:place` ones) that the query's number matches. */
  private houses(e: Entity, house: string): House[] {
    if (e.naddr === 0) return [];
    const bytes = this.source.read(this.header.addressesAt + e.addr * ADDRESS_BYTES, e.naddr * ADDRESS_BYTES);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const exact: House[] = [];
    const starts: House[] = [];
    for (let i = 0; i < e.naddr; i++) {
      const raw = this.string(v.getUint32(i * ADDRESS_BYTES, true));
      const folded = foldHouse(raw);
      if (!folded.startsWith(house)) continue;
      const rec: House = {
        index: e.addr + i,
        house: raw,
        lat: v.getInt32(i * ADDRESS_BYTES + 4, true) * COORD_SCALE,
        lon: v.getInt32(i * ADDRESS_BYTES + 8, true) * COORD_SCALE,
        bonus: folded === house ? 12 : 5,
      };
      (folded === house ? exact : starts).push(rec);
    }
    return [...exact, ...starts].slice(0, HOUSES_PER_STREET);
  }

  private settlementOf(e: Entity): SearchResult["settlement"] {
    if (e.parent === NONE) return null;
    const p = this.entity(e.parent);
    return { name: this.string(p.nameAt), nameEn: p.nameEnAt === NONE ? null : this.string(p.nameEnAt) };
  }

  private result(e: Entity, score: number): SearchResult {
    const kind = e.kind === EntityKind.place ? "place" : e.kind === EntityKind.street ? "street" : "poi";
    return {
      key: `e${e.id}`,
      kind,
      name: this.string(e.nameAt),
      nameEn: e.nameEnAt === NONE ? null : this.string(e.nameEnAt),
      house: null,
      tag: this.string(e.tagAt),
      settlement: this.settlementOf(e),
      lat: e.lat,
      lon: e.lon,
      score,
    };
  }

  private addressResult(
    owner: Entity,
    h: House,
    score: number,
    near: Coordinate | null,
  ): SearchResult {
    // Distance from the house, not from its street's middle.
    const shift = near ? 7 * (Math.log10(1 + haversineM(near, owner) / 1000) - Math.log10(1 + haversineM(near, h) / 1000)) : 0;
    return {
      key: `a${h.index}`,
      kind: "address",
      name: this.string(owner.nameAt),
      nameEn: owner.nameEnAt === NONE ? null : this.string(owner.nameEnAt),
      house: h.house,
      tag: this.string(owner.tagAt),
      settlement: owner.kind === EntityKind.place ? null : this.settlementOf(owner),
      lat: h.lat,
      lon: h.lon,
      score: score + shift,
    };
  }

  // --- File access ---------------------------------------------------------------------------

  private loadTokens() {
    if (this.tokenOffsets) return;
    const { tokens, tokenOffsetsAt, tokenBlobAt, postingStartsAt } = this.header;
    this.tokenOffsets = toU32(this.source.read(tokenOffsetsAt, (tokens + 1) * 4));
    this.tokenBlob = this.source.read(tokenBlobAt, this.tokenOffsets[tokens]).slice();
    this.postingStarts = toU32(this.source.read(postingStartsAt, (tokens + 1) * 4));
  }

  /** token[i] compared with `q` (ASCII), as bytes. */
  private compare(i: number, q: string): number {
    const offsets = this.tokenOffsets!;
    const blob = this.tokenBlob!;
    const a = offsets[i];
    const len = offsets[i + 1] - a;
    const n = Math.min(len, q.length);
    for (let k = 0; k < n; k++) {
      const d = blob[a + k] - q.charCodeAt(k);
      if (d !== 0) return d;
    }
    return len - q.length;
  }

  private lowerBound(q: string): number {
    let lo = 0;
    let hi = this.header.tokens;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.compare(mid, q) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Sorted unique entity ids of every token the query token matches (itself; or all it starts). */
  private postings(token: QueryToken): Uint32Array {
    this.loadTokens();
    const lo = this.lowerBound(token.text);
    // Tokens are [a-z0-9]: every one that starts with the text sorts below text + DEL.
    const hi = token.prefix
      ? this.lowerBound(token.text + "\x7f")
      : lo < this.header.tokens && this.compare(lo, token.text) === 0
        ? lo + 1
        : lo;
    if (hi <= lo) return new Uint32Array(0);
    const starts = this.postingStarts!;
    const count = Math.min(starts[hi] - starts[lo], MAX_POSTINGS);
    const ids = toU32(this.source.read(this.header.postingsAt + starts[lo] * 4, count * 4));
    if (hi - lo === 1) return ids;
    ids.sort();
    let n = 0;
    for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[n - 1]) ids[n++] = ids[i];
    return ids.subarray(0, n);
  }

  private entity(id: number): Entity {
    const cached = this.entities.get(id);
    if (cached) return cached;
    const block = Math.floor(id / ENTITY_BLOCK);
    let v = this.entityBlocks.get(block);
    if (!v) {
      const first = block * ENTITY_BLOCK;
      const n = Math.min(ENTITY_BLOCK, this.header.entities - first);
      const b = this.source.read(this.header.entitiesAt + first * ENTITY_BYTES, n * ENTITY_BYTES);
      v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      this.entityBlocks.set(block, v);
    }
    const at = (id % ENTITY_BLOCK) * ENTITY_BYTES;
    const u32 = (k: number) => v.getUint32(at + k, true);
    const e: Entity = {
      id,
      kind: v.getUint8(at),
      rank: v.getUint16(at + 2, true),
      lat: v.getInt32(at + 4, true) * COORD_SCALE,
      lon: v.getInt32(at + 8, true) * COORD_SCALE,
      nameAt: u32(12),
      nameEnAt: u32(16),
      tagAt: u32(20),
      parent: u32(24),
      addr: u32(28),
      naddr: u32(32),
      child: u32(36),
      nchild: u32(40),
    };
    this.entities.set(id, e);
    return e;
  }

  private string(offset: number): string {
    const cached = this.strings.get(offset);
    if (cached !== undefined) return cached;
    const at = this.header.stringsAt + offset;
    const lenBytes = this.source.read(at, 2);
    const len = lenBytes[0] | (lenBytes[1] << 8);
    const s = decodeUtf8(this.source.read(at + 2, len));
    this.strings.set(offset, s);
    return s;
  }
}
