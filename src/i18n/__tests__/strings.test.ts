import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import enPermissions from "../../../locales/en.json";
import ukPermissions from "../../../locales/uk.json";

const entries = Object.entries(uk) as [keyof typeof en, string][];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Strings that are the same in both languages on purpose: names and symbols. */
const SAME_IN_BOTH = new Set<keyof typeof en>([
  "gpsOk",
  "vin",
  "englishLanguage",
  "ukrainianLanguage",
  "unavailableValue",
  "srcGnss",
]);

/**
 * One word per thing across the app. Each pattern is the form to avoid (Russianisms and calques included); the
 * comment names the one to use.
 */
const AVOID: [RegExp, string][] = [
  [/карт[аиуіоє]/i, "мапа"],
  [/сенсор/i, "датчик"],
  [/геолокац/i, "геопозиція"],
  [/(?<!\p{L})програм(?:а|и|і|у|ою|ам|ами|ах)?(?!\p{L})/iu, "застосунок"],
  [/під['’]єдна|від['’]єдна/i, "підключити / відключити"],
  [/замовчуванн/i, "типово"],
  [/торкн/i, "натисніть"],
  [/слідуюч|являєть|на протязі|співпада/i, "Russianism"],
];

describe("Ukrainian strings", () => {
  test("have the same keys as English", () => {
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
  });

  test("keep every placeholder of the English", () => {
    const wrong = entries.filter(([key, text]) => placeholders(text).join() !== placeholders(en[key]).join());
    expect(wrong.map(([key]) => key)).toEqual([]);
  });

  test("are translated", () => {
    const same = entries.filter(([key, text]) => text === en[key] && !SAME_IN_BOTH.has(key));
    expect(same.map(([key]) => key)).toEqual([]);
  });

  test("use GPS rather than GNSS in both languages", () => {
    const technical = [...Object.entries(en), ...entries].filter(([, text]) => /\bGNSS\b/i.test(text));
    expect(technical).toEqual([]);
  });

  test("do not confuse OBD speed with individual wheel speeds", () => {
    expect(entries.filter(([, text]) => /швидкост[ію] коліс/i.test(text)).map(([key]) => key)).toEqual([]);
  });

  test("iOS permission descriptions cover the same permissions and use consistent terms", () => {
    expect(Object.keys(ukPermissions).sort()).toEqual(Object.keys(enPermissions).sort());
    expect(ukPermissions.NSLocationWhenInUseUsageDescription).toContain("геопозицію");
    expect(ukPermissions.NSBluetoothAlwaysUsageDescription).toMatch(/підключатися.*OBD-II.*швидкість авто/);
  });

  test("use the typographic apostrophe and «» quotes", () => {
    expect(entries.filter(([, text]) => /'|"|“|”/.test(text)).map(([key]) => key)).toEqual([]);
  });

  test.each(AVOID)("avoid %s (use %s)", (pattern) => {
    expect(entries.filter(([, text]) => pattern.test(text)).map(([key]) => key)).toEqual([]);
  });
});
