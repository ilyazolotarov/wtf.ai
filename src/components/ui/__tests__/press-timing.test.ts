import { holdLeft, pressFeedback, PRESS_HOLD_MS, PRESS_IN_MS, PRESS_OUT_MS } from "@/components/ui/press-timing";

/**
 * The pressed look (UI-SPEC §4.8): a tap shows for at least PRESS_HOLD_MS from the touch, so a quick or scripted tap
 * is seen; a touch that turns into a scroll lets go at once; a touch while it eases out starts it over.
 */

function harness() {
  let clock = 0;
  const easings: { to: 0 | 1; duration: number; delay: number; at: number }[] = [];
  const deferred: (() => void)[] = [];
  const feedback = pressFeedback(
    () => clock,
    (to, duration, delay) => easings.push({ to, duration, delay, at: clock }),
    (run) => deferred.push(run),
  );
  return {
    feedback,
    easings,
    at(ms: number) {
      clock = ms;
    },
    /** The rest of the task: what a press-out waited for runs. */
    settle() {
      deferred.splice(0).forEach((run) => run());
    },
  };
}

describe("press feedback timing", () => {
  it("a 50 ms tap stays pressed until 150 ms, then eases out", () => {
    const h = harness();
    h.feedback.pressIn();
    h.at(50);
    h.feedback.pressOut();
    h.feedback.press();
    h.settle();
    expect(h.easings).toEqual([
      { to: 1, duration: PRESS_IN_MS, delay: 0, at: 0 },
      { to: 0, duration: PRESS_OUT_MS, delay: PRESS_HOLD_MS - 50, at: 50 },
    ]);
    // About a third of a second on screen in all.
    expect(50 + h.easings[1].delay + PRESS_OUT_MS).toBeGreaterThanOrEqual(350);
  });

  it("holds whichever comes first, the press or the press-out (React Native delays a quick press-out)", () => {
    const h = harness();
    h.feedback.pressIn();
    h.at(20);
    h.feedback.press();
    h.at(130);
    h.feedback.pressOut();
    h.settle();
    expect(h.easings[1]).toMatchObject({ to: 0, delay: 20 });
  });

  it("a press held past the minimum eases out at once", () => {
    const h = harness();
    h.feedback.pressIn();
    h.at(400);
    h.feedback.pressOut();
    h.feedback.press();
    h.settle();
    expect(h.easings[1]).toMatchObject({ to: 0, delay: 0 });
  });

  it("a touch that becomes a scroll doesn't hold", () => {
    const h = harness();
    h.feedback.pressIn();
    h.at(130);
    h.feedback.pressOut();
    h.settle();
    expect(h.easings[1]).toMatchObject({ to: 0, delay: 0 });
  });

  it("a touch while it eases out starts over, its hold counted from the new touch", () => {
    const h = harness();
    h.feedback.pressIn();
    h.at(50);
    h.feedback.pressOut();
    h.feedback.press();
    h.settle();
    h.at(200);
    h.feedback.pressIn();
    h.at(230);
    h.feedback.pressOut();
    h.feedback.press();
    h.settle();
    expect(h.easings.slice(2)).toEqual([
      { to: 1, duration: PRESS_IN_MS, delay: 0, at: 200 },
      { to: 0, duration: PRESS_OUT_MS, delay: PRESS_HOLD_MS - 30, at: 230 },
    ]);
  });

  it("the hold left never goes below zero or past the minimum", () => {
    expect(holdLeft(0, 0)).toBe(PRESS_HOLD_MS);
    expect(holdLeft(0, 1000)).toBe(0);
    expect(holdLeft(100, 50)).toBe(PRESS_HOLD_MS);
  });
});
