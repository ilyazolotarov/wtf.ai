// Android foreground service wrapper: no-op elsewhere, localized copy, never throws.

import { Platform } from "react-native";

import { setTripService, tripNotificationCopy, updateTripNotification } from "../trip-service";

jest.mock("../../../modules/sensor-capture/src/SensorCaptureModule", () => ({
  __esModule: true,
  default: {
    startTripService: jest.fn(async () => true),
    stopTripService: jest.fn(async () => undefined),
    updateTripService: jest.fn(() => true),
  },
}));
jest.mock("expo-localization", () => ({ getLocales: jest.fn(() => [{ languageCode: "en" }]) }));
jest.mock("expo-sqlite/kv-store", () => ({ __esModule: true, default: { getItemSync: jest.fn(() => null) } }));
jest.mock("react-native", () => {
  const platform = { OS: "ios" };
  return { Platform: platform };
});

const native = jest.requireMock("../../../modules/sensor-capture/src/SensorCaptureModule").default;
const storage = jest.requireMock("expo-sqlite/kv-store").default;

const setOs = (os: string) => {
  (Platform as { OS: string }).OS = os;
};

beforeEach(() => {
  jest.clearAllMocks();
  storage.getItemSync.mockReturnValue(null);
  native.startTripService.mockResolvedValue(true);
});

describe("trip service", () => {
  test("does nothing off Android", async () => {
    setOs("ios");
    expect(await setTripService(true)).toBe(false);
    expect(native.startTripService).not.toHaveBeenCalled();
  });

  test("starts with the English copy by default and reports it running", async () => {
    setOs("android");
    expect(await setTripService(true)).toBe(true);
    expect(native.startTripService).toHaveBeenCalledWith("Tracking your trip", "Tap to open the map.", "Trip in progress", "Turn on GPS");
  });

  test("uses the stored language preference over the system locale", () => {
    storage.getItemSync.mockReturnValue("uk");
    expect(tripNotificationCopy().title).toBe("Відстежуємо вашу поїздку");
  });

  test("stops the service and reports not running", async () => {
    setOs("android");
    expect(await setTripService(false)).toBe(false);
    expect(native.stopTripService).toHaveBeenCalled();
  });

  test("a refusal or an error from native is reported as not running, never thrown", async () => {
    setOs("android");
    native.startTripService.mockResolvedValueOnce(false);
    expect(await setTripService(true)).toBe(false);
    native.startTripService.mockRejectedValueOnce(new Error("boom"));
    expect(await setTripService(true)).toBe(false);
  });
});

describe("the notification while sharing the car's position", () => {
  test("says what the other apps get, under the sharing title", () => {
    setOs("android");
    expect(updateTripNotification("car")).toBe(true);
    expect(native.updateTripService).toHaveBeenCalledWith(
      "Sharing the car's position",
      "GPS is unreliable. Sharing the estimated position with Waze and Google Maps.",
      "Trip in progress",
    );
  });

  test("the service started again (the app back in front) keeps the notice; a new trip starts with the trip's words", async () => {
    setOs("android");
    updateTripNotification("car");
    await setTripService(true);
    expect(native.startTripService).toHaveBeenLastCalledWith(
      "Sharing the car's position",
      "GPS is unreliable. Sharing the estimated position with Waze and Google Maps.",
      "Trip in progress",
      "Turn on GPS",
    );
    await setTripService(false);
    await setTripService(true);
    expect(native.startTripService).toHaveBeenLastCalledWith("Tracking your trip", "Tap to open the map.", "Trip in progress", "Turn on GPS");
  });

  test("not sharing is told under the trip's own title; null brings back the trip's words", () => {
    expect(tripNotificationCopy("failed").title).toBe("Tracking your trip");
    expect(tripNotificationCopy(null)).toEqual(tripNotificationCopy());
  });

  test("uses the Ukrainian sharing copy when selected", () => {
    storage.getItemSync.mockReturnValue("uk");
    expect(tripNotificationCopy("car")).toMatchObject({
      title: "Передаємо позицію авто",
      text: "GPS ненадійний. Передаємо розраховану позицію у Waze і Google Maps.",
    });
  });

  test("not showing (no service yet, an old build, not Android) is false, never thrown", () => {
    setOs("android");
    native.updateTripService.mockReturnValueOnce(false);
    expect(updateTripNotification("gps")).toBe(false);
    native.updateTripService.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(updateTripNotification("gps")).toBe(false);
    setOs("ios");
    expect(updateTripNotification("gps")).toBe(false);
  });
});
