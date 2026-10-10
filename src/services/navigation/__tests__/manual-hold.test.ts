import { destinationAtBearing } from "@/nav/geo";
import type { GnssFix } from "@/nav/types";
import type { StoredManualPosition } from "@/services/navigation/calibration-store";
import { MANUAL_ASK_AFTER_MS, ManualHold } from "@/services/navigation/manual-hold";

const at = { lat: 50.45, lon: 30.52 };
const placing: StoredManualPosition = { ...at, headingRad: 0, placedAt: 0, confirmedAt: 0 };

function setup(stored: StoredManualPosition | null = null) {
  let saved: StoredManualPosition | null = stored;
  let now = 0;
  const hold = new ManualHold(
    { manualPosition: () => saved, saveManualPosition: (m) => (saved = m) },
    () => now,
  );
  return { hold, saved: () => saved, setNow: (ms: number) => (now = ms) };
}

const fix = (distanceM: number, hAccM = 5): GnssFix => ({ tUs: 0, ...destinationAtBearing(at, 0, distanceM), hAccM });

describe("the manual position", () => {
  test("outlives the session: held from storage, saved when set or dropped", () => {
    const { hold, saved } = setup(placing);
    expect(hold.current).toEqual(placing);
    hold.drop();
    expect(hold.current).toBeNull();
    expect(saved()).toBeNull();
    hold.hold(placing);
    expect(saved()).toEqual(placing);
  });

  test("asks once, 15 min after the driver confirmed it", () => {
    const { hold, setNow } = setup(placing);
    setNow(MANUAL_ASK_AFTER_MS - 1);
    expect(hold.asking()).toBe(false);
    expect(hold.askNote()).toBeNull();
    setNow(MANUAL_ASK_AFTER_MS);
    expect(hold.asking()).toBe(true);
    expect(hold.askNote()).toMatch(/15 min old/);
    expect(hold.askNote()).toBeNull();
    // Confirmed again: asked again 15 min later.
    hold.hold({ ...placing, confirmedAt: MANUAL_ASK_AFTER_MS });
    setNow(2 * MANUAL_ASK_AFTER_MS);
    expect(hold.askNote()).toMatch(/15 min old/);
  });

  test("a trusted fix that agrees releases it to GPS", () => {
    const { hold } = setup(placing);
    expect(hold.checkAgainst(fix(20))).toMatch(/GPS trusted, fix 20 m away/);
    expect(hold.current).toBeNull();
  });

  test("five trusted fixes in a row that disagree release it; a new navigator counts afresh", () => {
    const { hold } = setup(placing);
    for (let i = 0; i < 4; i++) expect(hold.checkAgainst(fix(500))).toBeNull();
    hold.setApplied(false);
    for (let i = 0; i < 4; i++) expect(hold.checkAgainst(fix(500))).toBeNull();
    expect(hold.checkAgainst(fix(500))).toMatch(/5 trusted GPS fixes disagree, the last 500 m away/);
    expect(hold.current).toBeNull();
  });
});
