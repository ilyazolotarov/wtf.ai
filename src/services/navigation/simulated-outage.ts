import { haversineM } from "@/nav/geo";
import type { PositionEstimate, SimulatedOutage } from "@/nav/position/types";
import { isSatelliteRecord } from "@/services/position/gnss-position-source";
import type { GnssRecord } from "@/triplog/schema";

/** A withheld fix is the truth when it is a satellite fix this accurate and recent. */
const TRUTH_MAX_ACC_M = 10;
const TRUTH_MAX_AGE_MS = 3000;

/**
 * Test tool (NAVIGATOR-SPEC §9): GNSS withheld from the navigator as a real outage would, while the sensors keep
 * logging it. The map shows the withheld fix and how far the dot is from it.
 */
export class SimulatedOutageTool {
  /** `hidden`: the newest fix withheld. */
  private outage: { startedAt: number; startDistanceM: number | null; hidden: GnssRecord | null; maxErrorM: number } | null = null;

  get on(): boolean {
    return this.outage !== null;
  }

  /** `startDistanceM`: the navigator's OBD distance now (null: no navigator). */
  start(nowMs: number, startDistanceM: number | null): void {
    this.outage = { startedAt: nowMs, startDistanceM, hidden: null, maxErrorM: 0 };
  }

  /** Over: its trip-log line, from what the map last showed of it. */
  stop(nowMs: number, shown: SimulatedOutage | undefined): string {
    const parts = [`${Math.round((nowMs - (this.outage?.startedAt ?? nowMs)) / 1000)} s`];
    if (shown?.distanceM !== undefined) parts.push(`${(shown.distanceM / 1000).toFixed(2)} km`);
    if (shown?.errorM !== undefined) parts.push(`dot ${Math.round(shown.errorM)} m from GPS (max ${Math.round(shown.maxErrorM ?? 0)} m)`);
    this.outage = null;
    return `sim gnss outage off: ${parts.join(", ")}`;
  }

  /** A fix the navigator doesn't get. */
  withhold(r: GnssRecord): void {
    if (this.outage) this.outage.hidden = r;
  }

  /** What the map shows of it for position `p`; `obdDistanceM`: the navigator's now (undefined: no navigator). */
  info(p: PositionEstimate, nowMs: number, obdDistanceM: number | undefined): SimulatedOutage | undefined {
    const o = this.outage;
    if (!o) return undefined;
    const h = o.hidden;
    const truth =
      h && isSatelliteRecord(h) && h.hAccM <= TRUTH_MAX_ACC_M && nowMs - h.utcUs / 1000 <= TRUTH_MAX_AGE_MS
        ? { lat: h.latDeg, lon: h.lonDeg, accuracyM: h.hAccM, timestamp: h.utcUs / 1000 }
        : undefined;
    const errorM = truth ? haversineM(p, truth) : undefined;
    if (errorM !== undefined) o.maxErrorM = Math.max(o.maxErrorM, errorM);
    return {
      startedAt: o.startedAt,
      ...(obdDistanceM !== undefined && o.startDistanceM !== null ? { distanceM: Math.max(0, obdDistanceM - o.startDistanceM) } : {}),
      ...(truth ? { gnss: truth, errorM, maxErrorM: o.maxErrorM } : {}),
    };
  }
}
