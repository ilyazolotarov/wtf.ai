import { formatAge, formatDuration } from "@/components/status/format-time";
import { en } from "@/i18n/en";

const t = (key: keyof typeof en) => en[key];

describe("format-time", () => {
  test("duration as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(-5000)).toBe("0:00");
  });

  test("age in words", () => {
    expect(formatAge(30_000, t)).toBe(en.ageJustNow);
    expect(formatAge(-1, t)).toBe(en.ageJustNow);
    expect(formatAge(12 * 60_000, t)).toBe(en.ageMinutes.replace("{m}", "12"));
    expect(formatAge(65 * 60_000, t)).toBe(en.ageHours.replace("{h}", "1").replace("{m}", "5"));
  });
});
