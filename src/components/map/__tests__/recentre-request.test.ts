import { onRecentreRequest, requestRecentre } from "../recentre-request";

describe("recentre request", () => {
  test("the phone's camera button reaches every listening map, until each lets go", () => {
    const heard: string[] = [];
    const releaseCar = onRecentreRequest(() => heard.push("car"));
    const releaseOther = onRecentreRequest(() => heard.push("other"));
    requestRecentre();
    expect(heard).toEqual(["car", "other"]);
    releaseCar();
    requestRecentre();
    expect(heard).toEqual(["car", "other", "other"]);
    releaseOther();
    requestRecentre();
    expect(heard).toHaveLength(3);
  });

  test("a listener that lets go while being called doesn't skip the next one", () => {
    const heard: string[] = [];
    const release = onRecentreRequest(() => {
      heard.push("first");
      release();
    });
    const releaseSecond = onRecentreRequest(() => heard.push("second"));
    requestRecentre();
    expect(heard).toEqual(["first", "second"]);
    releaseSecond();
  });
});
