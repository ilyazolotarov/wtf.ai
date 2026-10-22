import type { CanSpeed } from "../can-speed";
import { SpeedProbation } from "../probation";

/** True speed, km/h, of a stop-and-go drive: 20 s standing, then 60 s cycles of 0 → `top` → 0 with a 10 s stop. */
function kphAt(tS: number, top = 60): number {
  if (tS < 20) return 0;
  const c = (tS - 20) % 60;
  if (c < 15) return (top * c) / 15;
  if (c < 35) return top;
  if (c < 50) return (top * (50 - c)) / 15;
  return 0;
}

interface Fault {
  /** CAN speed = true × scale + offset (km/h). */
  scale?: number;
  offsetKph?: number;
  /** Rear-left wheel × this. */
  rearLeft?: number;
}

/**
 * The app's probation input: each 0.5 s a poll (OBD in whole km/h at the poll's midpoint), and the monitor's 10 Hz
 * CAN samples in the rest of the half second (a ~0.25 s break around each poll, as on the vLinker).
 */
function drive(durationS: number, fault: Fault = {}, top = 60): SpeedProbation {
  const p = new SpeedProbation();
  for (let ms = 0; ms <= durationS * 1000; ms += 50) {
    const tS = ms / 1000;
    const tUs = ms * 1000;
    const phase = ms % 500;
    if (phase === 0) p.addObd(tUs, Math.round(kphAt(tS, top)));
    // Listening between 150 ms and 400 ms of each half second, one sample per 0.1 s.
    if (phase === 200 || phase === 300 || phase === 400) {
      const kph = kphAt(tS, top) * (fault.scale ?? 1) + (fault.offsetKph ?? 0);
      const v = Math.max(0, kph) / 3.6;
      const wheels: [number, number, number, number] = [v, v, v * (fault.rearLeft ?? 1), v];
      const mean = wheels.reduce((a, b) => a + b, 0) / 4;
      const s: CanSpeed = { tUs, speedMps: mean, wheelsMps: wheels, gear: "D", reverse: false };
      p.addCan(s);
    }
  }
  return p;
}

describe("SpeedProbation", () => {
  it("passes a profile that reads the car's speed", () => {
    const v = drive(600).verdict;
    expect(v?.pass).toBe(true);
    expect(v?.stats.scale).toBeCloseTo(1, 2);
    expect(v?.stats.correlation).toBeGreaterThan(0.999);
    expect(v?.stats.standShare).toBe(1);
    expect(v?.stats.wheelOff).toBeLessThan(0.001);
  });

  it("passes a car whose wheels read a few per cent above its OBD speed (tyres, carstate's factors)", () => {
    expect(drive(600, { scale: 1.035 }).verdict?.pass).toBe(true);
  });

  it("fails a speed in the wrong unit", () => {
    const v = drive(600, { scale: 1.609 }).verdict;
    expect(v).toMatchObject({ pass: false, reason: "scale" });
  });

  it("fails one wheel read from the wrong signal", () => {
    const v = drive(600, { rearLeft: 1.25 }).verdict;
    expect(v).toMatchObject({ pass: false, reason: "wheels" });
  });

  it("fails a speed that doesn't drop to zero when the car stands", () => {
    const v = drive(600, { offsetKph: 6 }).verdict;
    expect(v?.pass).toBe(false);
    expect(v?.reason).toMatch(/standstill|spread/);
  });

  it("gives no verdict on a drive too short or too slow to tell", () => {
    expect(drive(40).verdict).toBeNull();
    expect(drive(900, {}, 15).verdict).toBeNull();
  });

  it("a long drive without a stop waits for one, however long: no stop is no data, not a fail", () => {
    const p = new SpeedProbation();
    // Connected while rolling: 20 min between 60 and 100 km/h, then a stop.
    const kph = (tS: number) => (tS < 1200 ? 80 + 20 * Math.sin(tS / 30) : tS < 1230 ? 80 - (80 * (tS - 1200)) / 30 : 0);
    for (let ms = 0; ms <= 1260_000; ms += 50) {
      const tUs = ms * 1000;
      if (ms % 500 === 0) p.addObd(tUs, Math.round(kph(ms / 1000)));
      if (ms % 500 >= 200 && ms % 100 === 0) p.addCan({ tUs, speedMps: kph(ms / 1000) / 3.6, wheelsMps: null, gear: "D", reverse: false });
      if (ms === 1200_000) {
        expect(p.stats().scalePairs).toBeGreaterThan(2000);
        expect(p.verdict).toBeNull();
      }
    }
    expect(p.verdict).toMatchObject({ pass: true });
  });

  it("takes no pair across a gap longer than a poll's break", () => {
    const p = new SpeedProbation();
    const can = (tUs: number, kph: number): CanSpeed => ({ tUs, speedMps: kph / 3.6, wheelsMps: null, gear: null, reverse: false });
    p.addCan(can(0, 50));
    p.addObd(500_000, 50);
    p.addCan(can(1_000_000, 50));
    expect(p.stats().scalePairs).toBe(0);
    p.addObd(1_200_000, 50);
    p.addCan(can(1_400_000, 50));
    expect(p.stats().scalePairs).toBe(1);
  });

  it("doesn't count a reversing car as standing when its ECU reads 0", () => {
    const p = new SpeedProbation();
    const can = (tUs: number): CanSpeed => ({ tUs, speedMps: 2, wheelsMps: null, gear: "R", reverse: true });
    p.addCan(can(0));
    p.addObd(100_000, 0);
    p.addCan(can(200_000));
    expect(p.stats().standPairs).toBe(0);
  });
});
