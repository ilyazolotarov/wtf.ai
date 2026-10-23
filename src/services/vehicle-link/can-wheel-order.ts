// Which wheel is which in a find of four wheel fields (VEHICLE-LINK-SPEC §16.6): while the car drives on a find whose
// order isn't known, its frames are read field by field, averaged as the feed averages wheels, and fitted against the
// phone's gyro (`WheelOrderFinder`). What a drive learned is kept per VIN, so short drives add up. The verdict goes to
// the discovery (`CanDiscovery.setOrder`): the order's wheels turn the car from the next drive.
import { CanSpeedAverager } from "@/nav/odometry/can/can-speed";
import { fieldKey, fieldSpeeds, foundKey, speedKey, tidy, type DiscoveredSpeed } from "@/nav/odometry/can/discovery";
import { FrameRetimer } from "@/nav/odometry/can/frame-timing";
import { WheelOrderFinder, type WheelOrderSums, type WheelOrderVerdict } from "@/nav/odometry/can/wheel-order";
import { ImuProcessor } from "@/nav/odometry/imu/imu-processor";
import type { ImuSample } from "@/nav/types";
import type { CanFrame } from "@/obd/can-monitor";
import type { KeyValueStore } from "@/obd/vehicle-link-core";

/** VIN → what the gyro taught about the car's find so far. */
export const CAN_WHEEL_ORDER_KEY = "vehicleLink.canWheelOrder";

interface OrderRecord {
  /** The find's key without an order (`speedKey`): another find starts over. */
  key: string;
  sums: WheelOrderSums;
  /** The gyro said its fields aren't four wheels: nothing more is learned. */
  notWheels?: string;
}

/** A stretch of the fit is this much driving (`WHEEL_ORDER.stretchSamples` samples of 0.1 s). */
const STRETCH_S = 5;

export interface CanWheelOrderDeps {
  vin(): string | null;
  /** The car's find in use (discovery found it), null: none. */
  find(): DiscoveredSpeed | null;
  onFrames(listener: (frames: CanFrame[]) => void): () => void;
  /** Each listening window's end: a break in the frames (frame-timing.ts). */
  onWindow(listener: () => void): () => void;
  /** The phone's motion samples, in batches. */
  onImu(listener: (samples: ImuSample[]) => void): () => void;
  /** The gyro's verdict on the find: its order, or not four wheels. */
  decided(find: DiscoveredSpeed, verdict: WheelOrderVerdict, learnedS: number): void;
  store: KeyValueStore;
  note(text: string): void;
}

interface Learning {
  vin: string;
  find: DiscoveredSpeed;
  key: string;
  finder: WheelOrderFinder;
  read: (data: ArrayLike<number>, len: number) => number[] | null;
  averager: CanSpeedAverager;
  retimer: FrameRetimer;
  gyro: ImuProcessor;
}

export class CanWheelOrder {
  private off: (() => void) | null = null;
  private learning: Learning | null = null;

  constructor(private readonly deps: CanWheelOrderDeps) {}

  /** Learning which wheel is which now. */
  get active(): boolean {
    return this.learning !== null;
  }

  start(): void {
    if (this.off) return;
    const offs = [
      this.deps.onFrames((frames) => this.onFrames(frames)),
      this.deps.onWindow(() => this.learning?.retimer.break()),
      this.deps.onImu((samples) => this.onImu(samples)),
    ];
    this.off = () => offs.forEach((o) => o());
    this.refresh();
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.learning = null;
  }

  /** Searches the gyro decided against get another (the driver turned the wheels' speed on again). */
  forgetNotWheels(): void {
    const kept = Object.fromEntries(Object.entries(this.records()).filter(([, r]) => !r.notWheels));
    this.deps.store.setJson(CAN_WHEEL_ORDER_KEY, kept);
  }

  /** On every change of the car or of its find: whether there is an order to learn. */
  refresh(): void {
    if (!this.off) return;
    const vin = this.deps.vin();
    const find = this.deps.find();
    const due = vin !== null && find !== null && find.fields.length === 4 && !find.order;
    const key = due ? speedKey(foundKey(find)) : null;
    if (this.learning && this.learning.vin === vin && this.learning.key === key) return;
    this.learning = null;
    if (!due || !key) return;
    const record = this.records()[vin];
    const same = record?.key === key ? record : null;
    if (same?.notWheels) return;
    this.learning = {
      vin,
      find,
      key,
      finder: new WheelOrderFinder(same?.sums ?? null),
      read: fieldSpeeds(find),
      averager: new CanSpeedAverager(),
      retimer: new FrameRetimer(),
      gyro: new ImuProcessor(),
    };
    const minutes = same ? ` (${((same.sums.n * STRETCH_S) / 60).toFixed(1)} min so far)` : "";
    this.deps.note(`can discovery: learning which wheel is which in ${hex(find.id)} from the gyro${minutes}`);
  }

  private onFrames(frames: CanFrame[]): void {
    const l = this.learning;
    if (!l) return;
    const before = l.finder.stretches;
    for (const f of frames) {
      if (f.id !== l.find.id) continue;
      const v = l.read(f.data, f.data.length);
      if (!v) continue;
      const tUs = l.retimer.retime(f.id, f.rxUs);
      for (const c of l.averager.push({ q: "wheels", tUs, v: v as [number, number, number, number] })) l.finder.addFields(c.tUs, c.wheelsMps!);
    }
    if (l.finder.stretches !== before) this.learned(l);
  }

  private onImu(samples: ImuSample[]): void {
    const l = this.learning;
    if (!l) return;
    const before = l.finder.stretches;
    for (const s of samples) {
      const o = l.gyro.process(s);
      l.finder.addGyro(s.tUs, o.valid ? o.yawRate : null);
    }
    if (l.finder.stretches !== before) this.learned(l);
  }

  /** A stretch fitted: kept, and the verdict once there is one. */
  private learned(l: Learning): void {
    const verdict = l.finder.verdict();
    const record: OrderRecord = { key: l.key, sums: l.finder.sums, ...(verdict && !verdict.order ? { notWheels: verdict.reason } : {}) };
    this.save(l.vin, verdict?.order ? null : record);
    if (!verdict) return;
    this.learning = null;
    const learnedS = l.finder.stretches * STRETCH_S;
    const minutes = (learnedS / 60).toFixed(1);
    if (verdict.order) {
      const fields = tidy(l.find.fields);
      const wheels = ["fl", "fr", "rl", "rr"].map((w, i) => `${w} ${fieldKey(fields[verdict.order![i]])}`).join(", ");
      this.deps.note(
        `can discovery: wheels of ${hex(l.find.id)} by the gyro: ${wheels} (track ${verdict.trackM.toFixed(2)} m, wheelbase ` +
          `${verdict.wheelbaseM.toFixed(2)} m, from ${minutes} min); turns from them from the next drive`,
      );
    } else {
      this.deps.note(`can discovery: ${hex(l.find.id)}'s fields aren't four wheels by the gyro (${verdict.reason}, from ${minutes} min); turns stay on the phone's gyro`);
    }
    this.deps.decided(l.find, verdict, learnedS);
  }

  private records(): Record<string, OrderRecord> {
    return this.deps.store.getJson<Record<string, OrderRecord>>(CAN_WHEEL_ORDER_KEY) ?? {};
  }

  /** Null: the order is the find's now (`CanDiscovery`), nothing of it kept here. */
  private save(vin: string, record: OrderRecord | null): void {
    const all = { ...this.records() };
    if (record) all[vin] = record;
    else delete all[vin];
    this.deps.store.setJson(CAN_WHEEL_ORDER_KEY, all);
  }
}

const hex = (id: number) => id.toString(16).toUpperCase();
