import type { Clock } from "@/obd/clock";
import { CLONE_PROFILE, Elm327Emulator, GENUINE_PROFILE, STN_PROFILE } from "@/obd/emulator";
import type { ConnectedInfo } from "@/obd/types";

const PROFILES = {
  "emulator:genuine": GENUINE_PROFILE,
  "emulator:clone": CLONE_PROFILE,
  "emulator:stn": STN_PROFILE,
} as const;

/** Dev-only fake adapter with a repeating drive cycle: idle → accelerate → cruise → brake → stop-start → key off. */
export class DrivingEmulator extends Elm327Emulator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;

  constructor(id: string, clock: Clock) {
    super(clock, PROFILES[id as keyof typeof PROFILES] ?? GENUINE_PROFILE);
  }

  override async connect(): Promise<ConnectedInfo> {
    this.t0 = Date.now();
    if (!this.timer) this.timer = setInterval(() => this.step(), 200);
    return super.connect();
  }

  override async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return super.disconnect();
  }

  private step(): void {
    const t = ((Date.now() - this.t0) / 1000) % 120;
    if (t < 10) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else if (t < 25) this.setVehicle({ ignition: true, rpm: 2500, speedKph: ((t - 10) / 15) * 60 });
    else if (t < 50) this.setVehicle({ ignition: true, rpm: 1800, speedKph: 60 + 3 * Math.sin(t) });
    else if (t < 60) this.setVehicle({ ignition: true, rpm: 1000, speedKph: 60 * (1 - (t - 50) / 10) });
    else if (t < 75) this.setVehicle({ ignition: true, rpm: 0, speedKph: 0 }); // auto stop-start
    else if (t < 95) this.setVehicle({ ignition: true, rpm: 2000, speedKph: ((t - 75) / 20) * 40 });
    else if (t < 100) this.setVehicle({ ignition: true, rpm: 800, speedKph: 0 });
    else this.setVehicle({ ignition: false, rpm: 0, speedKph: 0 }); // key off for 20 s
  }
}
