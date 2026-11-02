import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import { PlaceFlag } from "@/nav/search/places";

import { hoursText, placeDetail } from "../stop-text";

const tEn = (key: keyof typeof en) => en[key];
const tUk = (key: keyof typeof uk) => uk[key];
const d = (day: number, h: number, m = 0) => day * 1440 + h * 60 + m;
// Weekdays 8–21, Saturday 9–20, Sunday closed.
const cafe = [...[0, 1, 2, 3, 4].flatMap((day) => [d(day, 8), d(day, 21)]), d(5, 9), d(5, 20)];
// 2026-11-02 is a Monday.
const at = (date: number, h: number, m = 0) => new Date(2026, 10, date, h, m);

describe("opening hours in words (STOPS-SPEC §7.2)", () => {
  test("open till its closing, closed till its opening", () => {
    expect(hoursText(cafe, at(2, 10), tEn)).toBe("open till 21:00");
    expect(hoursText(cafe, at(2, 22, 15), tEn)).toBe("closed till 8:00");
    expect(hoursText(cafe, at(2, 22, 15), tUk)).toBe("зачинено до 8:00");
  });

  test("a day or more away: with the day", () => {
    // Saturday evening: Monday morning next.
    expect(hoursText(cafe, at(7, 20, 30), tEn)).toBe("closed till Mon 8:00");
    expect(hoursText(cafe, at(7, 20, 30), tUk)).toBe("зачинено до пн 8:00");
    // Open all weekend: till Sunday 24:00, that is Monday 0:00.
    expect(hoursText([d(5, 0), d(7, 0)], at(7, 10), tEn)).toBe("open till Mon 0:00");
  });

  test("never closing, never opening", () => {
    expect(hoursText([0, 7 * 1440], at(4, 3), tEn)).toBe("24/7");
    expect(hoursText([], at(4, 3), tUk)).toBe("зачинено");
  });

  test("in a row's detail: after the side and fuels; 24/7 by its flag; nothing when unknown", () => {
    const now = at(2, 10).getTime();
    expect(placeDetail({ category: "cafe", flags: 0, hours: cafe }, "right", tEn, now)).toBe("right · open till 21:00");
    expect(placeDetail({ category: "fuel", flags: PlaceFlag.open24h | PlaceFlag.diesel, hours: [0, 7 * 1440] }, null, tEn, now)).toBe("diesel · 24/7");
    expect(placeDetail({ category: "cafe", flags: 0, hours: null }, "left", tEn, now)).toBe("left");
    expect(placeDetail({ category: "cafe", flags: 0 }, null, tEn, now)).toBe("");
  });
});
