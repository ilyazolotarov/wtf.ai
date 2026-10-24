// Folding names and queries into search tokens (SEARCH-SPEC §3). Keep in step with
// tools/tiles/tiles/search.py: the index holds tokens folded there, the query is folded here.
// Shared cases: __fixtures__/fold-cases.json, tested on both sides.

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh",
  з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ё: "e", ы: "y",
  э: "e", ъ: "", "'": "", "’": "", "ʼ": "", "`": "",
};
/** Latin spellings of є, ю, я at a word start (ye, yu, ya) fold like the ones inside a word. */
const DIGRAPHS: [string, string][] = [["ye", "ie"], ["yu", "iu"], ["ya", "ia"]];
const MARKS = /[̀-ͯ]/g;
const TOKEN = /[a-z0-9]+/g;
const HOUSE_DROP = /[^a-z0-9/]/g;

/** Street and settlement kinds (folded): a query may leave them out or abbreviate them. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "vulytsia", "vul", "provulok", "prov", "prospekt", "prosp", "ploshcha", "pl", "bulvar",
  "bulv", "shose", "naberezhna", "nab", "uzviz", "proizd", "aleia", "tupyk", "maidan",
  "mikroraion", "mkr", "mkrn", "kvartal", "ulytsa", "ul", "pereulok", "per", "ploshchad",
  "street", "st", "avenue", "ave", "lane", "ln", "square", "sq", "boulevard", "blvd", "road",
  "rd", "misto", "selo", "selyshche", "smt",
]);

/** Lower case, Cyrillic to Latin, diacritics dropped, digraph variants folded. */
export function translit(text: string): string {
  let s = "";
  for (const c of text.toLowerCase().normalize("NFC")) s += TRANSLIT[c] ?? c;
  s = s.normalize("NFD").replace(MARKS, "");
  for (const [a, b] of DIGRAPHS) s = s.split(a).join(b);
  return s;
}

/** Search tokens of a name or query: runs of ASCII letters and digits. */
export function fold(text: string): string[] {
  return translit(text).match(TOKEN) ?? [];
}

/** A house number for matching: "10-А" → "10a"; "12/2" keeps its slash. */
export function foldHouse(text: string): string {
  return translit(text).replace(HOUSE_DROP, "");
}

export interface QueryToken {
  text: string;
  /** The word being typed: matches every token it starts. */
  prefix: boolean;
  /** A street kind, one letter, or the start of a street kind being typed: never required. */
  optional: boolean;
  /** Part of the piece read as a house number. */
  house: boolean;
}

export interface ParsedQuery {
  tokens: QueryToken[];
  /** Folded house number: the last piece starting with a digit, when other words come with it. */
  house: string | null;
}

const isStopwordStart = (t: string) => {
  for (const w of STOPWORDS) if (w.startsWith(t)) return true;
  return false;
};

export function parseQuery(query: string): ParsedQuery {
  const pieces = query.split(/[\s,;]+/).filter(Boolean);
  const typing = !/[\s,;]$/.test(query);
  let houseIndex = -1;
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (/^\d/.test(pieces[i]) && pieces[i].length <= 10) {
      houseIndex = i;
      break;
    }
  }
  const tokens: QueryToken[] = [];
  pieces.forEach((piece, i) => {
    const words = fold(piece);
    words.forEach((text, j) => {
      const prefix = typing && i === pieces.length - 1 && j === words.length - 1;
      const optional =
        STOPWORDS.has(text) || (text.length === 1 && !/\d/.test(text)) || (prefix && isStopwordStart(text));
      tokens.push({ text, prefix, optional, house: i === houseIndex });
    });
  });
  const named = tokens.some((t) => !t.house && !/^\d+$/.test(t.text));
  const house = houseIndex >= 0 && named ? foldHouse(pieces[houseIndex]) : null;
  return { tokens, house: house || null };
}

// "під'їзд", "підʼїзд", "пiдїзд", "подъезд" (or "подьезд", "подезд"), "п." or "п", "entrance", "ent", "pidizd": the word for an entrance.
const ENTRANCE_WORD = String.raw`(?:п[іi]д['’ʼ\u0060]?[їi]зд|под[ъь]?езд|п\.?|entrance|entr?\.?|pid['’ʼ\u0060]?izd)`;
const ENTRANCE_AT_END = new RegExp(String.raw`(?:^|[\s,;])${ENTRANCE_WORD}\s*(\d{1,3}[a-zа-яієїґ]?)\s*$`, "iu");
/** "3 під'їзд", "3-й під'їзд": the number before the word. */
const ENTRANCE_BEFORE_WORD = new RegExp(String.raw`(?:^|[\s,;])(\d{1,3}[a-zа-яієїґ]?)(?:\s*-?\s*[йиі])?\s*${ENTRANCE_WORD}\s*$`, "iu");
/** Two numbers at the end ("Оболонський 16 3"): a house, then its entrance. */
const TWO_NUMBERS_AT_END = /(?:^|[\s,;])(\d[^\s,;]*)[\s,;]+(\d{1,3})\s*$/u;
/** The word alone (being typed, or the number not yet): dropped, so the house is still found meanwhile. */
const ENTRANCE_WORD_AT_END = new RegExp(String.raw`(?:^|[\s,;])(?:п[іi]д['’ʼ\u0060]?[їi]?з?д?|под[ъь]?е?з?д?|entr?a?n?c?e?)\s*$`, "iu");

/**
 * A query ending in an entrance ("Оболонський 16 під'їзд 3", "…16, п. 3", "…16 entrance 3", "…16 3 під'їзд",
 * "…16 3"): the rest, and the entrance's number folded like a house number. Only after a house number.
 */
export function splitEntrance(query: string): { rest: string; entrance: string | null } {
  const hasHouse = (rest: string) => /(?:^|[\s,;])\d/.test(rest);
  for (const re of [ENTRANCE_AT_END, ENTRANCE_BEFORE_WORD]) {
    const m = re.exec(query);
    if (m && hasHouse(query.slice(0, m.index))) return { rest: query.slice(0, m.index), entrance: foldHouse(m[1]) };
  }
  // "16 3": the street's name before them, so "8 Березня 3" (a house 3 on 8 Березня) stays a house.
  const two = TWO_NUMBERS_AT_END.exec(query);
  if (two) {
    const rest = query.slice(0, two.index + two[0].indexOf(two[1]) + two[1].length);
    if (/[^\d\s,;]/.test(query.slice(0, two.index))) return { rest, entrance: foldHouse(two[2]) };
  }
  const w = ENTRANCE_WORD_AT_END.exec(query);
  if (w && w[0].trim().length > 1) {
    const rest = query.slice(0, w.index);
    if (/(?:^|[\s,;])\d[^\s,;]*[\s,;]*$/.test(rest)) return { rest: rest + " ", entrance: null };
  }
  return { rest: query, entrance: null };
}
