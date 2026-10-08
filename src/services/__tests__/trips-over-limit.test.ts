// The storage limit's choice of logs to delete (TRIP-LOGGER-SPEC §7.2).
import { tripsOverLimit, type TripIndexEntry } from "../trip-recorder/trip-recorder";

const trip = (id: string, startUtcMs: number, mb: number): TripIndexEntry =>
  ({ id, fileName: `${id}.ulg`, startUtcMs, bytes: mb * 1e6, distanceM: 0, startReason: "engine", complete: true }) as TripIndexEntry;

const trips = [trip("c", 3, 30), trip("a", 1, 10), trip("d", 4, 5), trip("b", 2, 20)];

describe("tripsOverLimit", () => {
  it("deletes nothing under the limit", () => {
    expect(tripsOverLimit(trips, null, 65e6)).toEqual([]);
  });

  it("deletes the oldest until everything fits", () => {
    expect(tripsOverLimit(trips, null, 50e6)).toEqual(["a", "b"]);
  });

  it("counts the log being written but never deletes it", () => {
    expect(tripsOverLimit(trips, "a", 50e6)).toEqual(["b"]);
    expect(tripsOverLimit(trips, "a", 30e6)).toEqual(["b", "c"]);
  });

  it("keeps logs still waiting for upload", () => {
    expect(tripsOverLimit(trips, null, 40e6, new Set(["a.ulg", "b.ulg"]))).toEqual(["c"]);
    expect(tripsOverLimit(trips, null, 0, new Set(["a.ulg", "b.ulg", "c.ulg", "d.ulg"]))).toEqual([]);
  });
});
