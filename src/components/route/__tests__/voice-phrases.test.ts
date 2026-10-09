import { readFileSync } from "node:fs";
import path from "node:path";

import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import { SPOKEN_DISTANCES_M, type Announcement } from "@/nav/routing/announcer";
import type { Maneuver } from "@/nav/routing/maneuvers";

import { announcementPhrases, recordedPhrases } from "../voice-phrases";

const tUk = (key: keyof typeof uk) => uk[key];
const tEn = (key: keyof typeof en) => en[key];
const m = (kind: Maneuver["kind"], exit?: number): Maneuver => ({ kind, atM: 0, lat: 51, lon: 31, turnRad: 0, exit });
const ahead = (maneuver: Maneuver, distanceM: number): Announcement => ({ kind: "maneuver", stage: "prepare", maneuver, distanceM, then: null });
const now = (maneuver: Maneuver, then: Maneuver | null = null): Announcement => ({ kind: "maneuver", stage: "now", maneuver, distanceM: 30, then });

describe("voice phrases", () => {
  test("whole phrases in words a driver hears: distances in their grammatical form, exits as ordinals", () => {
    expect(announcementPhrases(ahead(m("left"), 300), tUk, "uk")).toEqual([{ id: "ahead-300-left", text: "Через триста метрів, поверніть ліворуч" }]);
    expect(announcementPhrases(ahead(m("roundabout", 2), 1500), tUk, "uk")[0].text).toBe("Через півтора кілометра, на колі — другий з’їзд");
    expect(announcementPhrases(now(m("right"), m("arrive")), tUk, "uk").map((p) => p.text)).toEqual(["Поверніть праворуч", "і ви на місці"]);
    expect(announcementPhrases(now(m("roundabout", 3)), tEn, "en")[0].text).toBe("At the roundabout, take the third exit");
  });

  test("slight turns include an instruction in Ukrainian", () => {
    expect(announcementPhrases(now(m("slight-left")), tUk, "uk")[0].text).toBe("Плавно поверніть ліворуч");
    expect(announcementPhrases(ahead(m("slight-right"), 300), tUk, "uk")[0].text).toBe("Через триста метрів, плавно поверніть праворуч");
  });

  test("a word for every spoken distance", () => {
    for (const strings of [en, uk]) expect(strings.sayDistances.split("|")).toHaveLength(SPOKEN_DISTANCES_M.length);
  });

  test("every announcement of a usual maneuver has a recorded phrase", () => {
    const recorded = new Set(recordedPhrases(tUk, "uk").map((p) => p.id));
    const kinds: Maneuver[] = ["slight-left", "slight-right", "left", "right", "sharp-left", "sharp-right", "keep-left", "keep-right", "u-turn"].map((k) => m(k as Maneuver["kind"]));
    const maneuvers = [...kinds, ...[1, 2, 3, 4, 5, 6].map((n) => m("roundabout", n))];
    const all: Announcement[] = [
      { kind: "replanned" },
      { kind: "arrived" },
      ...maneuvers.flatMap((x) => [now(x), now(x, m("arrive")), ...maneuvers.map((y) => now(x, y)), ...SPOKEN_DISTANCES_M.map((d) => ahead(x, d))]),
    ];
    const missing = all.flatMap((a) => announcementPhrases(a, tUk, "uk")).filter((p) => !recorded.has(p.id));
    expect(missing).toEqual([]);
    // A 7th exit isn't recorded: the system voice says it.
    expect(recorded.has(announcementPhrases(now(m("roundabout", 7)), tUk, "uk")[0].id)).toBe(false);
  });

  test("the recorded clips are those of the current words (npm run voice:render)", () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, "../../../../assets/voice/uk/phrases.json"), "utf8"));
    expect(manifest.phrases).toEqual(Object.fromEntries(recordedPhrases(tUk, "uk").map((p) => [p.id, p.text])));
  });
});
