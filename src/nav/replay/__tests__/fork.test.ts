import { readFileSync } from "node:fs";
import path from "node:path";

import { syntheticDrive, type DriveSegment } from "@/nav/__fixtures__/synthetic-drive";
import { deepCopy } from "@/nav/deep-copy";
import { LocalFrame } from "@/nav/geo/local-frame";
import { bufferByteSource } from "@/nav/mapmatch/graph/byte-source";
import { TiledRoadGraph } from "@/nav/mapmatch/graph/road-graph";
import { replayTrip, TripReplay, type ReplayOptions, type ReplayResult } from "@/nav/replay/replay";

describe("deepCopy", () => {
  class Point {
    constructor(
      public x: number,
      public y: number,
    ) {}
    norm() {
      return Math.hypot(this.x, this.y);
    }
  }

  test("copies classes, collections and typed arrays; shared references stay shared", () => {
    const p = new Point(3, 4);
    const buffer = new ArrayBuffer(16);
    const a = new Float64Array(buffer, 0, 1);
    const b = new Float64Array(buffer, 8, 1);
    const original = { p, again: p, list: [p, 1, "s", null], map: new Map([["k", p]]), set: new Set([p]), a, b, self: null as unknown };
    original.self = original;
    const copy = deepCopy(original);
    expect(copy.p).not.toBe(p);
    expect(copy.p).toBeInstanceOf(Point);
    expect(copy.p.norm()).toBe(5);
    expect(copy.again).toBe(copy.p);
    expect(copy.list[0]).toBe(copy.p);
    expect(copy.map.get("k")).toBe(copy.p);
    expect([...copy.set][0]).toBe(copy.p);
    expect(copy.self).toBe(copy);
    expect(copy.a.buffer).toBe(copy.b.buffer);
    expect(copy.a.buffer).not.toBe(buffer);
    copy.b[0] = 7;
    expect(b[0]).toBe(0);
    copy.p.x = 0;
    expect(p.x).toBe(3);
  });

  test("known objects stay (or stand in); a function throws", () => {
    const shared = { big: true };
    const standIn = { other: true };
    const replaced = { old: true };
    const copy = deepCopy({ shared, replaced }, new Map<object, unknown>([[shared, shared], [replaced, standIn]]));
    expect(copy.shared).toBe(shared);
    expect(copy.replaced).toBe(standIn);
    expect(() => deepCopy({ inner: { f: () => 1 } })).toThrow("inner.f");
  });
});

// The fixture graph's long road (as particle-filter.test.ts): east along way 160/161, then left onto 162.
const FIXTURE = readFileSync(path.join(__dirname, "../../mapmatch/__fixtures__/net.graph.bin"));
const ORIGIN = { lat: 51.53, lon: 30.75 };
const graph = () => new TiledRoadGraph(bufferByteSource(new Uint8Array(FIXTURE)), new LocalFrame(ORIGIN));
const DRIVE: DriveSegment[] = [
  { durationS: 3, speedMps: 0, yawRateDegS: 0 },
  { durationS: 144, speedMps: 12, yawRateDegS: 0 },
  { durationS: 6, speedMps: 5, yawRateDegS: 0 },
  { durationS: 4.5, speedMps: 5, yawRateDegS: 20 },
  { durationS: 20, speedMps: 10, yawRateDegS: 0 },
];

describe("TripReplay forks", () => {
  const drive = syntheticDrive({ segments: DRIVE, origin: ORIGIN, startHeadingRad: Math.PI / 2, gnss: "clean", obdScale: 0.99 });
  // Re-anchoring every 300 m moves the frame often: forks share the graph, each in its own frame.
  const base = (): ReplayOptions => ({ nav: { reanchorM: 300 }, mapMatch: { graph: graph(), config: { seed: 3 } } });
  // What a fork must reproduce exactly (the filter's update times are wall-clock, so left out).
  const withoutTimes = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(withoutTimes) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "updateMs" ? 0 : withoutTimes(x)])) : v;
  const outcome = (r: ReplayResult) =>
    withoutTimes({ track: r.track, fixes: r.fixes, cuts: r.summary.cuts, init: r.summary.init, endPose: r.summary.endPose });

  test("a window continued on a fork equals the replay with that cut from the start", () => {
    const shared = base();
    const main = TripReplay.start(drive.trip, shared);
    // Two windows from one start (60 s, and 30 s by ending the longer one early), then a later one.
    const forked: ReplayResult[] = [];
    main.runBefore(40);
    const long = main.fork();
    long.addCut({ fromS: 40, toS: 100 });
    long.runBefore(70);
    const short = long.fork();
    short.endLastCut(70);
    short.runTo(75);
    long.runTo(105);
    forked.push(long.finish(), short.finish());
    main.runBefore(120);
    const late = main.fork();
    late.addCut({ fromS: 120, toS: 160 });
    late.runTo(165);
    forked.push(late.finish());
    main.runTo(Infinity);
    forked.push(main.finish());

    const fresh = (cuts: ReplayOptions["cuts"], untilS?: number) => replayTrip(drive.trip, { ...base(), cuts, ...(untilS !== undefined ? { untilS } : {}) });
    const expected = [fresh([{ fromS: 40, toS: 100 }], 105), fresh([{ fromS: 40, toS: 70 }], 75), fresh([{ fromS: 120, toS: 160 }], 165), fresh([])];
    expect(forked.map(outcome)).toEqual(expected.map(outcome));
    // The windows did run the filter through the outage.
    expect(forked[0].summary.cuts[0].truthFixes).toBeGreaterThan(30);
    expect(forked[0].track.at(-1)!.mapMatch?.state).not.toBe("off");
  });

  test("a cut that has started, or an open-loop replay, can't be added", () => {
    const r = TripReplay.start(drive.trip, base());
    r.runTo(50);
    expect(() => r.addCut({ fromS: 50, toS: 60 })).toThrow();
    const open = TripReplay.start(drive.trip, { ...base(), openLoop: { delayS: 0 } });
    expect(() => open.addCut({ fromS: 50, toS: 60 })).toThrow();
  });
});
