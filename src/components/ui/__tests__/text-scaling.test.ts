import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { growth, MAX_FONT_SCALE } from "@/components/ui/text";

jest.mock("@/global.css", () => ({}));

/**
 * Text keeps to its layouts at a large system text size (UI-SPEC §4.7): the app's text is `T` (text.tsx), which
 * follows the system's size up to a cap; React Native's own `Text` and `TextInput` grow without limit, so each one
 * outside `T` carries a cap. The rest (wrapping, stacking, what fits) is seen on the emulator:
 * `scripts/android-ui-sweep.py`.
 */

const SRC = path.join(__dirname, "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

/** The opening tags of `<Name ...>` in a file (JSX attributes can hold `=>`, so braces are counted). */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  const re = new RegExp(`<${name}[\\s>/]`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 0;
    let i = m.index + 1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

const files = sources(SRC).filter((f) => !f.endsWith(path.join("components", "ui", "text.tsx")));

describe("text at a large system size", () => {
  it.each(["Text", "TextInput"])("every React Native <%s> outside T has a cap", (name) => {
    const uncapped = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      // Only React Native's: a file importing it from "react-native".
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"react-native"`).test(source);
      if (!imported) return [];
      return openingTags(source, name)
        .filter((tag) => !/maxFontSizeMultiplier|allowFontScaling=\{false\}/.test(tag))
        .map((tag) => `${path.relative(SRC, file)}: ${tag.split("\n")[0]}`);
    });
    expect(uncapped).toEqual([]);
  });

  it("body text grows with the system up to the cap", () => {
    expect(growth(1.3, 15)).toBeCloseTo(1.3);
    expect(growth(MAX_FONT_SCALE, 13)).toBeCloseTo(MAX_FONT_SCALE);
  });

  it("large text grows less, so headings keep the room for the rest", () => {
    const body = growth(MAX_FONT_SCALE, 15);
    const title = growth(MAX_FONT_SCALE, 30);
    const hero = growth(MAX_FONT_SCALE, 44);
    expect(title).toBeLessThan(body);
    expect(hero).toBeLessThan(title);
    expect(hero).toBeGreaterThan(1);
    // The order of sizes holds: a larger style never comes out smaller.
    for (let size = 8; size < 60; size++) expect(size * growth(2, size)).toBeLessThan((size + 1) * growth(2, size + 1));
  });

  it("a smaller system size shrinks every size alike", () => {
    expect(growth(0.85, 15)).toBeCloseTo(0.85);
    expect(growth(0.85, 40)).toBeCloseTo(0.85);
  });
});
