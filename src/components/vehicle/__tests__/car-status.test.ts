import { speedFromText } from "../car-status";
import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";

const base = { wheelSpeed: true, speedFromCan: false, canOff: null };

describe("speedFromText", () => {
  it("the source only: the car's data bus or OBD, in both languages", () => {
    expect(speedFromText({ ...base, speedFromCan: true }, (key) => en[key])).toBe("Car data bus");
    expect(speedFromText({ ...base, speedFromCan: true }, (key) => uk[key])).toBe("Шина даних авто");
    // The app's own steps and the reasons drivers can't act on: the trip log has them.
    expect(speedFromText(base, (key) => en[key])).toBe("OBD");
    expect(speedFromText({ ...base, wheelSpeed: false, speedFromCan: true }, (key) => en[key])).toBe("OBD");
    expect(speedFromText({ ...base, canOff: "adapter" }, (key) => en[key])).toBe("OBD");
    expect(speedFromText({ ...base, canOff: "car" }, (key) => en[key])).toBe("OBD");
  });

  it("the one reason the driver can act on: the adapter's firmware", () => {
    expect(speedFromText({ ...base, canOff: "firmware" }, (key) => en[key])).toBe(
      "OBD · the adapter stopped responding while reading the car's data bus: update its firmware",
    );
    expect(speedFromText({ ...base, canOff: "firmware" }, (key) => uk[key])).toBe(
      "OBD · адаптер перестав відповідати під час зчитування шини даних авто — оновіть його прошивку",
    );
    // Off in Settings: the firmware doesn't matter then.
    expect(speedFromText({ ...base, wheelSpeed: false, canOff: "firmware" }, (key) => en[key])).toBe("OBD");
  });
});
