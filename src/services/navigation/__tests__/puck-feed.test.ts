import type { PositionEstimate } from "@/nav/position/types";

import { type CompassCone, FEED_FLAG_DOUBT, FEED_FLAG_HIDDEN, FEED_FLAG_SNAP, type NavAdvance, PuckFeed, PuckFeeder } from "../puck-feed";

const M_PER_DEG_LAT = 111_320;

function position(over: Partial<PositionEstimate> = {}): PositionEstimate {
  return {
    lat: 50.45,
    lon: 30.52,
    headingRad: 0, // north
    speedMps: 20,
    accuracyM: 5,
    source: "gnss",
    trust: "TRUSTED",
    timestamp: 1_000,
    ...over,
  };
}

const metresNorth = (from: { lat: number }, to: { lat: number }) => (to.lat - from.lat) * M_PER_DEG_LAT;
const metresEast = (from: { lat: number; lon: number }, to: { lon: number }) => (to.lon - from.lon) * M_PER_DEG_LAT * Math.cos((from.lat * Math.PI) / 180);

describe("PuckFeed", () => {
  it("a publish is fed as drawn, predicted one interval ahead while moving", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const p = position();
    const fed = feed.publish(p)!;
    // 20 m/s for the default 100 ms lead: 2 m north.
    expect(metresNorth(p, fed)).toBeCloseTo(2, 1);
    expect(metresEast(p, fed)).toBeCloseTo(0, 1);
    expect(fed.courseDeg).toBe(0);
    expect(fed.leadMs).toBe(100);
    expect(fed.snap).toBe(true); // the first pose
    expect(fed.doubt).toBe(false);
  });

  it("advances move the published dot by the estimate's displacement since the publish", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const a0: NavAdvance = { lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 20, tUs: 0 };
    feed.advance(a0);
    const p = position();
    feed.publish(p);
    // The estimate moved 10 m north since the publish: the dot does too (plus the 2 m lead).
    now += 100;
    const a1: NavAdvance = { ...a0, lat: a0.lat + 10 / M_PER_DEG_LAT, tUs: 100 };
    const fed = feed.advance(a1)!;
    expect(metresNorth(p, fed)).toBeCloseTo(12, 1);
    expect(fed.snap).toBe(false);
  });

  it("the estimate's heading takes over once it turned away from the published one", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const a0: NavAdvance = { lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 20, tUs: 0 };
    feed.advance(a0);
    feed.publish(position());
    now += 100;
    expect(feed.advance({ ...a0, headingRad: (1 * Math.PI) / 180 })!.courseDeg).toBeCloseTo(0, 5);
    now += 100;
    expect(feed.advance({ ...a0, headingRad: (10 * Math.PI) / 180 })!.courseDeg).toBeCloseTo(10, 5);
  });

  it("a publish in a turn keeps the estimate's heading, never the old road's", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const a0: NavAdvance = { lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 20, tUs: 0 };
    feed.advance(a0);
    feed.publish(position());
    now += 100;
    feed.advance({ ...a0, headingRad: (40 * Math.PI) / 180 });
    // Map matching still has the car on the road it turns off: heading north.
    expect(feed.publish(position())!.courseDeg).toBeCloseTo(40, 5);
    now += 100;
    feed.advance({ ...a0, headingRad: (1 * Math.PI) / 180 });
    expect(feed.publish(position())!.courseDeg).toBeCloseTo(0, 5);
  });

  it("standing: fed at publishes only, no lead", () => {
    const feed = new PuckFeed(() => 0);
    const p = position({ speedMps: 0.5 });
    const fed = feed.publish(p)!;
    expect(fed.lat).toBe(p.lat);
    expect(fed.leadMs).toBe(0);
    expect(feed.advance({ lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 0.5, tUs: 0 })).toBeNull();
  });

  it("the lead follows the feed interval", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const a: NavAdvance = { lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 20, tUs: 0 };
    feed.advance(a);
    feed.publish(position());
    for (let i = 0; i < 20; i++) {
      now += 500;
      feed.advance(a);
    }
    expect(feed.advance(a)!.leadMs).toBeGreaterThan(450);
  });

  it("the lead covers the batches' gap, not their average with the ones close behind", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    const a: NavAdvance = { lat: 50.4, lon: 30.5, headingRad: 0, speedMps: 20, tUs: 0 };
    feed.advance(a);
    feed.publish(position());
    for (let i = 0; i < 20; i++) {
      now += i % 3 === 2 ? 20 : 100;
      feed.advance(a);
    }
    expect(feed.advance(a)!.leadMs).toBe(100);
    // Slower batches lengthen it at once; faster ones shorten it once the slow ones are out of the window.
    now += 300;
    expect(feed.advance(a)!.leadMs).toBe(300);
    for (let i = 0; i < 6; i++) {
      now += 50;
      feed.advance(a);
    }
    expect(feed.advance(a)!.leadMs).toBe(50);
  });

  it("without the navigator's steps the publishes pace the lead", () => {
    let now = 0;
    const feed = new PuckFeed(() => now);
    for (let i = 0; i < 20; i++) {
      now += 250;
      feed.publish(position());
    }
    expect(feed.publish(position())!.leadMs).toBeGreaterThan(200);
  });

  it("a jump, a placed position and doubt", () => {
    const feed = new PuckFeed(() => 0);
    feed.publish(position());
    const far = feed.publish(position({ lat: 50.46 }))!;
    expect(far.snap).toBe(true);
    const near = feed.publish(position({ lat: 50.4601 }))!;
    expect(near.snap).toBe(false);
    const placed = feed.publish(position({ lat: 50.4601, source: "manual", speedMps: 0 }))!;
    expect(placed.snap).toBe(true);
    expect(feed.publish(position({ lat: 50.4601, trust: "UNTRUSTED", speedMps: 0 }))!.doubt).toBe(true);
    expect(feed.publish(null)).toBeNull();
  });
});

describe("PuckFeeder", () => {
  function harness() {
    let snapshot: PositionEstimate | null = null;
    const listeners = new Set<() => void>();
    const advances = new Set<(a: NavAdvance) => void>();
    const feeder = new PuckFeeder({
      nowMs: () => 0,
      position: {
        subscribe: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        getSnapshot: () => snapshot,
        onAdvance: (l) => {
          advances.add(l);
          return () => advances.delete(l);
        },
      },
    });
    feeder.start();
    return {
      feeder,
      publish: (p: PositionEstimate | null) => {
        snapshot = p;
        listeners.forEach((l) => l());
      },
      advance: (a: NavAdvance) => advances.forEach((l) => l(a)),
    };
  }

  it("feeds active maps with the flags, and a late map gets the last pose placed", () => {
    const h = harness();
    const calls: number[][] = [];
    let hidden = false;
    let active = true;
    h.feeder.register({ feedUserLocation: (...args) => calls.push(args) }, { active: () => active, hidden: () => hidden });
    h.publish(position());
    expect(calls).toHaveLength(1);
    expect(calls[0][6]).toBe(FEED_FLAG_SNAP);
    hidden = true;
    h.publish(position({ trust: "REACQUIRING" }));
    expect(calls[1][6]).toBe(FEED_FLAG_DOUBT | FEED_FLAG_HIDDEN);
    active = false;
    h.publish(position());
    expect(calls).toHaveLength(2);
    const late: number[][] = [];
    h.feeder.register({ feedUserLocation: (...args) => late.push(args) }, { active: () => true, hidden: () => false });
    expect(late).toHaveLength(1);
    expect(late[0][6]).toBe(FEED_FLAG_SNAP);
  });

  it("a map's walking compass is its dot's cone: its heading and width, fed again as it turns, never placed again", () => {
    const h = harness();
    const calls: number[][] = [];
    let compass: CompassCone | null = { courseDeg: 120, halfDeg: 35 };
    const target = { feedUserLocation: (...args: number[]) => calls.push(args) };
    const registration = h.feeder.register(target, { active: () => true, hidden: () => false, compass: () => compass });
    h.publish(position({ speedMps: 1 }));
    expect([calls[0][2], calls[0][7]]).toEqual([120, 35]);
    compass = { courseDeg: 150, halfDeg: 20 };
    registration.compassTurned();
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 2)).toEqual(calls[0].slice(0, 2));
    expect([calls[1][2], calls[1][7]]).toEqual([150, 20]);
    expect(calls[1][6] & FEED_FLAG_SNAP).toBe(0);
    // Gone: the dot's own heading (north) and the style's cone.
    compass = null;
    registration.compassTurned();
    expect(calls[2][2]).toBe(0);
    expect(calls[2][7]).toBeNaN();
    // Unregistered: fed no more.
    registration.unregister();
    registration.compassTurned();
    h.publish(position({ speedMps: 1 }));
    expect(calls).toHaveLength(3);
  });

  it("a map whose view is gone is dropped, the others still fed", () => {
    const h = harness();
    const fed: number[][] = [];
    let gone = 0;
    h.feeder.register(
      {
        feedUserLocation: () => {
          gone += 1;
          throw new Error("NativeComponent ref is null");
        },
      },
      { active: () => true, hidden: () => false },
    );
    h.feeder.register({ feedUserLocation: (...args) => fed.push(args) }, { active: () => true, hidden: () => false });
    h.publish(position());
    h.publish(position());
    expect(gone).toBe(1);
    expect(fed).toHaveLength(2);
  });
});
