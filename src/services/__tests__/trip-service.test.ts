// Android foreground service wrapper: no-op elsewhere, localized copy, never throws.

import { Platform } from "react-native";

import { setTripService, tripNotificationCopy } from "../trip-service";

jest.mock("../../../modules/sensor-capture/src/SensorCaptureModule", () => ({
  __esModule: true,
  default: {
    startTripService: jest.fn(async () => true),
    stopTripService: jest.fn(async () => undefined),
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
    expect(native.startTripService).toHaveBeenCalledWith("wtf.ai is recording your trip", "Tap to open the map.", "Trip in progress");
  });

  test("uses the stored language preference over the system locale", () => {
    storage.getItemSync.mockReturnValue("uk");
    expect(tripNotificationCopy().title).toMatch(/записує/);
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
