// Which JS the app runs, as the About page, trip logs and Sentry see it (docs/OTA.md).

import { jsSource, jsSourceInfo } from "../js-source";

// An ES module, so `import * as Updates` reads it live; each test sets its fields.
jest.mock("expo-updates", () => Object.defineProperty({}, "__esModule", { value: true }));
const mockUpdates: Record<string, unknown> = jest.requireMock("expo-updates");

beforeEach(() => {
  for (const k of Object.keys(mockUpdates)) delete mockUpdates[k];
});

describe("jsSource / jsSourceInfo", () => {
  it("is off in a Debug build", () => {
    Object.assign(mockUpdates, { isEnabled: false, runtimeVersion: null });
    expect(jsSource()).toBe("off");
    expect(jsSourceInfo()).toEqual({ ver_update: "off", ver_runtime: "" });
  });

  it("names the build's own JS", () => {
    Object.assign(mockUpdates, { isEnabled: true, isEmbeddedLaunch: true, updateId: "e1", runtimeVersion: "fp1" });
    expect(jsSource()).toBe("embedded");
    expect(jsSourceInfo()).toEqual({ ver_update: "embedded", ver_runtime: "fp1" });
  });

  it("gives an OTA update by its id", () => {
    Object.assign(mockUpdates, { isEnabled: true, isEmbeddedLaunch: false, updateId: "u-123", runtimeVersion: "fp1" });
    expect(jsSource()).toBe("update");
    expect(jsSourceInfo().ver_update).toBe("u-123");
  });

  it("marks a fallback after a broken update", () => {
    Object.assign(mockUpdates, { isEnabled: true, isEmbeddedLaunch: true, isEmergencyLaunch: true, runtimeVersion: "fp1" });
    expect(jsSourceInfo().ver_update).toBe("embedded emergency");
  });
});
