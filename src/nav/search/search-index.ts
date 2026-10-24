// Offline address search (SEARCH-SPEC §5): queries a region's `<region>.search.bin` by random
// access. Synchronous and small: a query reads a few posting lists, the entities that match
// and a street's house numbers, well under the time of a keystroke on the JS thread.

import { haversineM, type Coordinate } from "@/nav/geo";
import type { ByteSource } from "@/nav/mapmatch/graph/byte-source";
import { fold, foldHouse, parseQuery, splitEntrance, STOPWORDS, type QueryToken } from "@/nav/search/fold";
import {
  ADDRESS_BYTES,
  COORD_SCALE,
  decodeUtf8,
  ENTITY_BYTES,
  ENTRANCE_BYTES,
  ENTRANCE_MAGIC,
  EntityKind,
  FLAG_ENTRANCES,
  HEADER_BYTES,
  NONE,
  TRAILER_BYTES,
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
  /** An entrance of the address, by its number ("3"): the result is that entrance's door. */
  entrance: string | null;
  /** An address's numbered entrances, to pick one on its card (none for other results and entrance results). */
  entrances: Entrance[];
  /** OSM tag that made it: "place=village", "highway=residential", "amenity=fuel", "addr:street" (a street known only from its houses). */
  tag: string;
  /** The settlement it belongs to (none for a settlement itself, or far from any). */
  settlement: { name: string; nameEn: string | null } | null;
  lat: number;
  lon: number;
  score: number;
}

/** Two results that read the same this close are one place on the screen (§5.3). */
const REPEAT_M = 150;

/**
 * Drops a result that reads the same as a better one nearby: OSM often maps one address several times (the
 * building, its entrances, a shop's address), which listed four identical "вулиця Хрещатик, 22" rows. `ranked`:
 * best first.
 */
export function withoutRepeats(ranked: SearchResult[]): SearchResult[] {
  const kept: SearchResult[] = [];
  for (const r of ranked) {
    const same = (k: SearchResult) =>
      k.kind === r.kind &&
      k.name === r.name &&
      k.house === r.house &&
      k.entrance === r.entrance &&
      k.settlement?.name === r.settlement?.name &&
      haversineM(k, r) < REPEAT_M;
    if (!kept.some(same)) kept.push(r);
  }
  return kept;
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
  /** The same for the index words the token reaches only with a typo (§4.2). */
  nearIds: Uint32Array;
  nearRanges: [number, number][];
  near: NearTokens;
  cost: number;
}

interface NearTokens {
  /** Token index ranges [lo, hi), outside the token's own. */
  spans: [number, number][];
  /** Whole words reached with a typo … */
  words: Set<string>;
  /** … and, for the word being typed, starts that every word extending them is. */
  starts: string[];
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
  /** Bit i: token i matched the entity's own names / its settlement's … */
  direct: number;
  via: number;
  /** … only with a typo. */
  typo: number;
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
/** How far a settlement's own reach goes (m), as the index builder gives streets to settlements. */
const SETTLEMENT_REACH_M: Record<string, number> = {
  "place=city": 15_000,
  "place=town": 6_000,
  "place=village": 2_500,
  "place=hamlet": 1_200,
};

/** A building's entrance (SEARCH-SPEC §3.2): its number if mapped, and where it is. */
export interface Entrance {
  ref: string | null;
  lat: number;
  lon: number;
}

interface EntranceTable {
  /** Address index of each entrance (NONE: none), ascending. */
  address: Uint32Array;
  ref: Uint32Array;
  lat: Int32Array;
  lon: Int32Array;
}

/**
 * Typos forgiven in a query word (a letter wrong, missed, extra or two swapped; the first letter kept): none under 4
 * letters (5 for the word being typed: its start is still short), one, two from 8 letters. Numbers none.
 */
export function typoBudget(t: QueryToken): number {
  if (/[0-9]/.test(t.text)) return 0;
  const n = t.text.length;
  return n >= 8 ? 2 : n >= (t.prefix ? 5 : 4) ? 1 : 0;
}

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
  /** Where the entrance section is ([offset, count]); null in a file without one. */
  private readonly entranceSection: [number, number] | null = null;
  private entranceTable: EntranceTable | null = null;

  constructor(private readonly source: ByteSource) {
    this.header = parseHeader(source.read(0, HEADER_BYTES));
    if (this.header.size !== source.size) {
      throw new Error(`search file is ${source.size} bytes, header says ${this.header.size}`);
    }
    if (this.header.flags & FLAG_ENTRANCES) {
      const t = source.read(source.size - TRAILER_BYTES, TRAILER_BYTES);
      const v = new DataView(t.buffer, t.byteOffset, TRAILER_BYTES);
      if (String.fromCharCode(...t.subarray(8, 12)) !== ENTRANCE_MAGIC) throw new Error("search file: no entrance trailer");
      this.entranceSection = [v.getUint32(0, true), v.getUint32(4, true)];
    }
  }

  /** Every entrance of the region, numbered or not (the map draws them). */
  allEntrances(): Entrance[] {
    const t = this.entrances();
    if (!t) return [];
    const out: Entrance[] = [];
    for (let i = 0; i < t.address.length; i++) out.push(this.entranceAt(t, i));
    return out;
  }

  /** The entrances of an address (an index in the file's address table), in their numbers' order. */
  entrancesOf(address: number): Entrance[] {
    const t = this.entrances();
    if (!t) return [];
    let lo = 0;
    let hi = t.address.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t.address[mid] < address) lo = mid + 1;
      else hi = mid;
    }
    const out: Entrance[] = [];
    for (let i = lo; i < t.address.length && t.address[i] === address; i++) out.push(this.entranceAt(t, i));
    return out;
  }

  private entranceAt(t: EntranceTable, i: number): Entrance {
    return {
      ref: t.ref[i] === NONE ? null : this.string(t.ref[i]),
      lat: t.lat[i] * COORD_SCALE,
      lon: t.lon[i] * COORD_SCALE,
    };
  }

  /** The entrance section, read once (16 bytes an entrance: a few MB for the whole country). */
  private entrances(): EntranceTable | null {
    if (!this.entranceSection) return null;
    if (this.entranceTable) return this.entranceTable;
    const [at, n] = this.entranceSection;
    const b = this.source.read(at, n * ENTRANCE_BYTES);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const t: EntranceTable = { address: new Uint32Array(n), ref: new Uint32Array(n), lat: new Int32Array(n), lon: new Int32Array(n) };
    for (let i = 0; i < n; i++) {
      const o = i * ENTRANCE_BYTES;
      t.address[i] = v.getUint32(o, true);
      t.ref[i] = v.getUint32(o + 4, true);
      t.lat[i] = v.getInt32(o + 8, true);
      t.lon[i] = v.getInt32(o + 12, true);
    }
    this.entranceTable = t;
    return t;
  }

  /**
   * The region's largest settlements: cities, then towns, by population (the file keeps its
   * settlements first, by rank). For the route screen's quick picks.
   */
  /**
   * The address nearest a point (a dropped pin), within `maxM` of its house: the house's street (or settlement for an
   * `addr:place` house) and number; null where none is that close. A house is where its building's centre is, so a
   * long block's ends are up to ~75 m from it. Reads the addresses of the few settlements whose reach the point is in
   * (a settlement's streets keep theirs in one block: all of a big city's in well under a megabyte).
   */
  nearestAddress(at: Coordinate, maxM = 75): SearchResult | null {
    let best: { owner: Entity; house: House; d: number } | null = null;
    for (const s of this.settlementsNear(at)) {
      // The settlement's own houses (`addr:place`), then its children's: one contiguous run of the address table.
      const ranges: [number, number][] = [[s.addr, s.addr + s.naddr]];
      if (s.nchild > 0) {
        const first = this.entity(s.child);
        const last = this.entity(s.child + s.nchild - 1);
        ranges.push([first.addr, last.addr + last.naddr]);
      }
      for (const [from, to] of ranges) {
        if (to <= from) continue;
        const bytes = this.source.read(this.header.addressesAt + from * ADDRESS_BYTES, (to - from) * ADDRESS_BYTES);
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const kx = Math.cos((at.lat * Math.PI) / 180);
        for (let i = 0; i < to - from; i++) {
          const lat = v.getInt32(i * ADDRESS_BYTES + 4, true) * COORD_SCALE;
          const lon = v.getInt32(i * ADDRESS_BYTES + 8, true) * COORD_SCALE;
          // Equirectangular metres: exact enough within a town, and cheap for 50 000 houses.
          const d = Math.hypot((lon - at.lon) * kx, lat - at.lat) * 111_195;
          if (d > maxM || (best && d >= best.d)) continue;
          const index = from + i;
          const owner = index < s.addr + s.naddr && index >= s.addr ? s : this.ownerOf(index, s);
          if (!owner) continue;
          const house = this.string(v.getUint32(i * ADDRESS_BYTES, true));
          best = { owner, house: { index, house, lat, lon, bonus: 0 }, d };
        }
      }
    }
    return best ? this.addressResult(best.owner, best.house, 0, null) : null;
  }

  /** The settlement a point is in (the nearest whose reach it is in, as the index gives streets theirs); null if none. */
  settlementAt(at: Coordinate): SearchResult | null {
    const [s] = this.settlementsNear(at, 1);
    return s ? this.result(s, 0) : null;
  }

  /** Settlements whose reach (§2: city 15 km, town 6, village 2.5, hamlet 1.2) the point is in, nearest first. */
  private settlementsNear(at: Coordinate, limit = 3): Entity[] {
    const near: { e: Entity; score: number }[] = [];
    for (let id = 0; id < this.header.settlements; id++) {
      const e = this.entity(id);
      const reach = SETTLEMENT_REACH_M[this.string(e.tagAt)] ?? 1_200;
      const score = haversineM(at, e) / reach;
      if (score <= 1) near.push({ e, score });
    }
    return near.sort((a, b) => a.score - b.score).slice(0, limit).map((n) => n.e);
  }

  /** The child of `settlement` whose houses include address `index` (children's address runs ascend with their ids). */
  private ownerOf(index: number, settlement: Entity): Entity | null {
    let lo = settlement.child;
    let hi = settlement.child + settlement.nchild - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.entity(mid).addr <= index) lo = mid;
      else hi = mid - 1;
    }
    // Entities without houses share the next one's start: step to the one that has it.
    for (let id = lo; id >= settlement.child; id--) {
      const e = this.entity(id);
      if (e.naddr > 0 && e.addr <= index && index < e.addr + e.naddr) return e;
      if (e.addr + e.naddr <= index) break;
    }
    return null;
  }

  majorSettlements(limit = 8): SearchResult[] {
    const out: SearchResult[] = [];
    for (let id = 0; id < this.header.settlements && out.length < limit; id++) {
      const e = this.entity(id);
      const tag = this.string(e.tagAt);
      if (tag !== "place=city" && tag !== "place=town") break; // villages follow
      out.push(this.result(e, 0));
    }
    return out;
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 20;
    const { rest, entrance } = splitEntrance(query);
    const parsed = parseQuery(rest);
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
    const sorted = [...best.values()].sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
    );
    return this.withEntrances(withoutRepeats(sorted), parsed.house, entrance).slice(0, limit);
  }

  /**
   * An entrance typed ("…16 під'їзд 3"): that door first, above its house (the best address whose number is the one
   * typed in full). Without one, the house's card offers its entrances (`SearchResult.entrances`).
   */
  private withEntrances(results: SearchResult[], house: string | null, entrance: string | null): SearchResult[] {
    if (!house || entrance === null || !this.entranceSection) return results;
    const at = results.findIndex((r) => r.kind === "address" && r.house !== null && foldHouse(r.house) === house);
    if (at < 0) return results;
    const addr = results[at];
    const doors = addr.entrances
      .filter((e) => foldHouse(e.ref!) === entrance)
      .map((e, i) => ({ ...addr, key: `${addr.key}e${i}`, entrance: e.ref, entrances: [], lat: e.lat, lon: e.lon }));
    return [...results.slice(0, at), ...doors, ...results.slice(at)];
  }

  private run(tokens: QueryToken[], house: string | null, near: Coordinate | null): SearchResult[] {
    // Street kinds ("вул.", "вули…" while typing) and single letters never decide a match.
    const use = tokens.filter((t) => !t.optional);
    if (use.length === 0) return [];
    const { matches, near: typos } = this.match(use);
    let ranked = matches.map((m) => {
      const e = this.entity(m.id);
      return { m, e, coarse: this.coarseScore(e, m, near) };
    });
    if (house) ranked = ranked.filter(({ e }) => e.naddr > 0 || e.kind === EntityKind.street);
    ranked.sort((a, b) => b.coarse - a.coarse);
    const out: SearchResult[] = [];
    for (const { m, e } of ranked.slice(0, house ? HOUSE_OWNERS : FULL_SCORED)) {
      const score = this.score(e, m, use, typos, tokens, near);
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
  private match(tokens: QueryToken[]): { matches: Match[]; near: NearTokens[] } {
    const sets: TokenSet[] = [];
    for (const token of tokens) {
      const ids = this.postings(token);
      const near = this.nearTokens(token, typoBudget(token));
      const nearIds = this.spanPostings(near.spans);
      const ranges = this.childRanges(ids);
      const nearRanges = this.childRanges(nearIds);
      const cost = ids.length + nearIds.length + [...ranges, ...nearRanges].reduce((n, [a, b]) => n + b - a, 0);
      if (cost === 0) return { matches: [], near: [] };
      sets.push({ token, ids, ranges, nearIds, nearRanges, near, cost });
    }
    const driver = sets.reduce((a, b) => (b.cost < a.cost ? b : a));
    const out: Match[] = [];
    const done = { matches: out, near: sets.map((s) => s.near) };
    const seen = new Set<number>();
    const test = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      let direct = 0;
      let via = 0;
      let typo = 0;
      for (let i = 0; i < sets.length; i++) {
        const s = sets[i];
        const bit = 1 << i;
        // Spelled right through its settlement beats a typo in its own name.
        if (contains(s.ids, id)) direct |= bit;
        else if (inRanges(s.ranges, id)) via |= bit;
        else if (contains(s.nearIds, id)) {
          direct |= bit;
          typo |= bit;
        } else if (inRanges(s.nearRanges, id)) {
          via |= bit;
          typo |= bit;
        } else return;
      }
      if (direct !== 0) out.push({ id, direct, via, typo });
    };
    for (const ids of [driver.ids, driver.nearIds]) {
      for (const id of ids) {
        test(id);
        if (out.length >= MAX_MATCHES) return done;
      }
    }
    for (const [start, end] of [...driver.ranges, ...driver.nearRanges]) {
      for (let id = start; id < end; id++) {
        test(id);
        if (out.length >= MAX_MATCHES) return done;
      }
    }
    return done;
  }

  /** Children of the settlements among `ids`: [start, end) sorted by start. */
  private childRanges(ids: Uint32Array): [number, number][] {
    const ranges: [number, number][] = [];
    for (const id of ids) {
      if (id >= this.header.settlements) break;
      const e = this.entity(id);
      if (e.nchild > 0) ranges.push([e.child, e.child + e.nchild]);
    }
    return ranges.sort((a, b) => a[0] - b[0]);
  }

  /** From what the ids and the record tell, before any name is decoded. */
  private coarseScore(e: Entity, m: Match, near: Coordinate | null): number {
    let score =
      8 * bits(m.direct & ~m.typo) + 5 * bits(m.via & ~m.typo) + 3 * bits(m.direct & m.typo) + 2 * bits(m.via & m.typo);
    score += this.kindScore(e);
    if (near) score -= 7 * Math.log10(1 + haversineM(near, e) / 1000);
    return score;
  }

  private kindScore(e: Entity): number {
    if (e.kind === EntityKind.place) return 4 + (e.rank / 65_535) * 24;
    if (e.kind === EntityKind.street) return 6 + (Math.min(e.rank, 30_000) / 30_000) * 4;
    return 3;
  }

  private score(
    e: Entity,
    m: Match,
    use: QueryToken[],
    typos: NearTokens[],
    all: QueryToken[],
    near: Coordinate | null,
  ): number {
    const name = this.string(e.nameAt);
    const nameEn = e.nameEnAt === NONE ? null : this.string(e.nameEnAt);
    const words = new Set([...fold(name), ...(nameEn ? fold(nameEn) : [])]);
    let score = 0;
    use.forEach((t, i) => {
      if (m.typo & (1 << i)) {
        score += m.direct & (1 << i) ? 3 : 2;
      } else if (m.direct & (1 << i)) {
        if (words.has(t.text)) score += 10;
        else if (t.prefix && [...words].some((w) => w.startsWith(t.text))) score += 7;
        else score += 6; // another of its names (old, Russian, alternative)
      } else {
        score += 5;
      }
    });
    // Words of its name the query left out; the whole name typed scores more.
    const typed = (w: string) =>
      all.some((t) => t.text === w || (t.prefix && w.startsWith(t.text))) ||
      typos.some((n) => n.words.has(w) || n.starts.some((p) => w.startsWith(p)));
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
    // One number mapped several times nearby (the building, its shops, an address point) is one house: the building
    // with entrances if one has them, so its card offers them. The copies took the five places of other numbers.
    const seen: { folded: string; rec: House; doors: boolean }[] = [];
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
      const doors = this.entrancesOf(rec.index).length > 0;
      const same = seen.find((s) => s.folded === folded && haversineM(s.rec, rec) < REPEAT_M);
      if (same) {
        if (doors && !same.doors) {
          Object.assign(same.rec, { index: rec.index, house: rec.house, lat: rec.lat, lon: rec.lon });
          same.doors = true;
        }
        continue;
      }
      seen.push({ folded, rec, doors });
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
      entrance: null,
      entrances: [],
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
      entrance: null,
      entrances: this.entrancesOf(h.index).filter((e) => e.ref !== null),
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

  /**
   * Index words within `budget` typos of the token (`typoBudget`), the first letter the same; for the word being
   * typed, the words that start within `budget` of it. The words sorted are walked as a trie: the edit-distance rows
   * (optimal string alignment) of a start shared with the word before are kept, and a start already too far, or
   * close enough as a start, settles every word that extends it at once.
   */
  private nearTokens(token: QueryToken, budget: number): NearTokens {
    const near: NearTokens = { spans: [], words: new Set(), starts: [] };
    if (budget === 0) return near;
    this.loadTokens();
    const offsets = this.tokenOffsets!;
    const blob = this.tokenBlob!;
    const q = token.text;
    const n = q.length;
    const rows: Uint8Array[] = [Uint8Array.from({ length: n + 1 }, (_, j) => j)];
    const text = (a: number, k: number) => String.fromCharCode(...blob.subarray(a, a + k));
    const hi = this.lowerBound(q[0] + "");
    let prev = -1;
    let valid = 0; // rows[0..valid] belong to the start of word `prev`
    for (let i = this.lowerBound(q[0]); i < hi; ) {
      const a = offsets[i];
      const len = offsets[i + 1] - a;
      let k = 0;
      if (prev >= 0) {
        const b = offsets[prev];
        const max = Math.min(valid, len, offsets[prev + 1] - b);
        while (k < max && blob[a + k] === blob[b + k]) k++;
      }
      let next = i + 1;
      let settled = false;
      for (k++; k <= len; k++) {
        const c = blob[a + k - 1];
        const up = rows[k - 1];
        const row = (rows[k] ??= new Uint8Array(n + 1));
        row[0] = k;
        let least = k;
        for (let j = 1; j <= n; j++) {
          const qc = q.charCodeAt(j - 1);
          let d = Math.min(up[j] + 1, row[j - 1] + 1, up[j - 1] + (qc === c ? 0 : 1));
          if (k > 1 && j > 1 && c === q.charCodeAt(j - 2) && blob[a + k - 2] === qc) d = Math.min(d, rows[k - 2][j - 2] + 1);
          row[j] = d;
          if (d < least) least = d;
        }
        if (token.prefix && row[n] <= budget) {
          if (row[n] > 0) {
            const start = text(a, k);
            next = this.lowerBound(start + "");
            near.starts.push(start);
            near.spans.push([i, next]);
          } else {
            next = this.lowerBound(q + ""); // the token's own range
          }
          settled = true;
        } else if (least > budget) {
          next = this.lowerBound(text(a, k) + "");
          settled = true;
        }
        if (settled) break;
      }
      valid = settled ? k : len;
      if (!settled && !token.prefix && rows[len][n] > 0 && rows[len][n] <= budget) {
        near.words.add(text(a, len));
        near.spans.push([i, i + 1]);
      }
      prev = i;
      i = next;
    }
    return near;
  }

  /** Sorted unique entity ids of the tokens in `spans` (at most `MAX_POSTINGS` read). */
  private spanPostings(spans: [number, number][]): Uint32Array {
    if (spans.length === 0) return new Uint32Array(0);
    const starts = this.postingStarts!;
    const parts: Uint32Array[] = [];
    let total = 0;
    for (const [lo, hi] of spans) {
      const count = Math.min(starts[hi] - starts[lo], MAX_POSTINGS - total);
      if (count <= 0) break;
      parts.push(toU32(this.source.read(this.header.postingsAt + starts[lo] * 4, count * 4)));
      total += count;
    }
    const ids = new Uint32Array(total);
    let at = 0;
    for (const p of parts) {
      ids.set(p, at);
      at += p.length;
    }
    ids.sort();
    let m = 0;
    for (let i = 0; i < ids.length; i++) if (i === 0 || ids[i] !== ids[m - 1]) ids[m++] = ids[i];
    return ids.subarray(0, m);
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
