import { scrubBreadcrumb, scrubEvent, scrubText } from "@/config/sentry-scrub";

describe("Sentry scrubbing", () => {
  test("redacts coordinates and VINs in text", () => {
    expect(scrubText("fix at 50.450123, 30.523456 for JM3KFBDM1J0123456")).toBe("fix at [num], [num] for [vin]");
    expect(scrubText("speed 12.5 Hz, ELM327 v1.5, 7E8")).toBe("speed 12.5 Hz, ELM327 v1.5, 7E8");
  });

  test("drops sensitive keys and high-precision numbers in data", () => {
    const crumb = scrubBreadcrumb({
      message: "gnss 50.4501",
      data: { lat: 50.45, nested: { longitude: 30.5, hAcc: 4.25, value: 30.523456, count: 3 }, vin: "x" },
    });
    expect(crumb).toEqual({
      message: "gnss [num]",
      data: { lat: "[redacted]", nested: { longitude: "[redacted]", hAcc: 4.25, value: "[num]", count: 3 }, vin: "[redacted]" },
    });
  });

  test("scrubs event message, exceptions, extra, and removes user", () => {
    const e = scrubEvent({
      message: "at 49.839700",
      exception: { values: [{ value: "VIN JM3KFBDM1J0123456 failed" }] },
      extra: { position: { lat: 1 } },
      user: { id: "abc" },
      breadcrumbs: [{ message: "30.123456" }],
    });
    expect(e.message).toBe("at [num]");
    expect(e.exception?.values?.[0].value).toBe("VIN [vin] failed");
    expect(e.extra).toEqual({ position: "[redacted]" });
    expect(e.user).toBeUndefined();
    expect(e.breadcrumbs?.[0].message).toBe("[num]");
  });
});
