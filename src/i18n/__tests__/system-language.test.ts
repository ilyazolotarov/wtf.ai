import { systemLanguage } from "@/i18n/system-language";

const langs = (...codes: (string | null)[]) => codes.map((languageCode) => ({ languageCode }));

describe("systemLanguage", () => {
  test("the first of the user's languages the app speaks, Russian as Ukrainian", () => {
    expect(systemLanguage(langs("uk"))).toBe("uk");
    expect(systemLanguage(langs("ru", "en"))).toBe("uk");
    expect(systemLanguage(langs("en", "uk"))).toBe("en");
    expect(systemLanguage(langs("de", "uk"))).toBe("uk");
  });

  test("none of them: English", () => {
    expect(systemLanguage(langs("de", null))).toBe("en");
    expect(systemLanguage([])).toBe("en");
  });
});
