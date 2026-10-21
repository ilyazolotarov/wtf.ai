import { NativeModule, registerWebModule } from "expo";

import type { SensorCaptureEvents } from "./SensorCaptureModule";

// Native sensor capture is iOS-only; on web the recorder simply gets no GNSS/IMU data.
class SensorCaptureWebModule extends NativeModule<SensorCaptureEvents> {
  nowUs(): number {
    return performance.now() * 1000;
  }
  async getPermissions() {
    return { location: "denied" as const, accuracy: "reduced" as const };
  }
  async requestLocationPermission() {
    return "denied" as const;
  }
  async startGnss() {
    return false;
  }
  async stopGnss() {}
  async startImu() {
    return false;
  }
  async stopImu() {}
  launchInfo() {
    return { wallMs: Date.now(), uptimeUs: performance.now() * 1000, inBackground: false, reasons: [] };
  }
  async processStats() {
    return { footprintMb: NaN, headroomMb: NaN, cpuS: NaN, thermal: "nominal" as const, lowPower: false, memoryWarnings: 0 };
  }
  takeHealthReports() {
    return [];
  }
  async setLocationSession() {
    return false;
  }
  simulateSystemKill() {}
}

export default registerWebModule(SensorCaptureWebModule, "SensorCapture");
