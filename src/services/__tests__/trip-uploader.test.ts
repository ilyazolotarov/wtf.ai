// TripUploader: what gets sent when, and what each Worker answer does (TRIP-LOGGER-SPEC §7.1).
import type { RecorderSnapshot, TripIndexEntry } from "../trip-recorder/trip-recorder";
import { TripUploader, type HttpResult, type NetworkKind } from "../trip-upload/trip-uploader";

const trip = (fileName: string, startUtcMs: number): TripIndexEntry => ({
  id: fileName.slice(16, 22),
  fileName,
  startUtcMs,
  startReason: "engine",
  bytes: 1000,
  distanceM: 0,
  complete: true,
} as TripIndexEntry);

const A = "20261003-100247_aaaaaa.ulg";
const B = "20261004-100247_bbbbbb.ulg";
const C = "20261005-100247_cccccc.ulg";

function setup(opts: { trips?: TripIndexEntry[]; current?: string; network?: NetworkKind; answers?: Record<string, number | Error> } = {}) {
  const kv = new Map<string, unknown>();
  let code: string | null = null;
  let network: NetworkKind = opts.network ?? "wifi";
  const sent: string[] = [];
  const removed: string[] = [];
  let keepFiles = false;
  const answers = opts.answers ?? {};
  const snapshot = {
    state: "idle",
    current: opts.current ? { id: opts.current.slice(16, 22), fileName: opts.current } : null,
    trips: opts.trips ?? [trip(B, 2), trip(A, 1)],
  } as unknown as RecorderSnapshot;
  const make = () =>
    new TripUploader({
      baseUrl: "https://up.example",
      store: { getJson: <T,>(k: string) => (kv.get(k) as T) ?? null, setJson: (k, v) => kv.set(k, JSON.parse(JSON.stringify(v))) },
      secrets: { get: async () => code, set: async (c) => void (code = c), clear: async () => void (code = null) },
      network: async () => network,
      recorder: { getSnapshot: () => snapshot, tripUri: (f) => `file:///trips/${f}` },
      removeTrip: (f) => {
        removed.push(f);
        if (!keepFiles) snapshot.trips = snapshot.trips.filter((t) => t.fileName !== f);
      },
      putFile: async (url, uri, headers): Promise<HttpResult> => {
        const file = url.split("/").pop()!;
        expect(uri).toBe(`file:///trips/${file}`);
        expect(headers.Authorization).toBe("Bearer bakimtuvodsegap");
        sent.push(file);
        const a = answers[file] ?? 201;
        if (a instanceof Error) throw a;
        return { status: a, body: a >= 400 ? JSON.stringify({ error: `e${a}` }) : "{}" };
      },
      get: async (url, headers) =>
        headers.Authorization === "Bearer bakimtuvodsegap" ? { status: 200, body: JSON.stringify({ name: "tester-a" }) } : { status: 401, body: "{}" },
      now: () => 42,
    });
  return { make, sent, removed, keepDeletes: () => (keepFiles = true), setNetwork: (n: NetworkKind) => (network = n), snapshot, getCode: () => code };
}

describe("TripUploader", () => {
  it("does nothing until a code is entered", async () => {
    const s = setup();
    const up = s.make();
    await up.run();
    expect(s.sent).toEqual([]);
    expect(up.getSnapshot().status).toBe("off");
  });

  it("checks the code, keeps it normalized, then sends the waiting logs oldest first", async () => {
    const s = setup();
    const up = s.make();
    expect(await up.connect("bakim-tuvod")).toBe("malformed");
    expect(await up.connect("babab-babab-babab")).toBe("rejected");
    expect(await up.connect(" BAKIM TUVOD SEGAP ")).toBe("ok");
    expect(s.getCode()).toBe("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([A, B]);
    expect(s.removed).toEqual([A, B]);
    expect(up.getSnapshot()).toMatchObject({ name: "tester-a", status: "idle", sentCount: 2, uploaded: {} });
    await up.run();
    expect(s.sent).toEqual([A, B]);
  });

  it("never sends the log being written", async () => {
    const s = setup({ trips: [trip(A, 1), trip(B, 2)], current: B });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([A]);
  });

  it("waits for Wi-Fi unless told otherwise", async () => {
    const s = setup({ network: "cellular" });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([]);
    expect(up.getSnapshot().status).toBe("waitingWifi");
    up.setWifiOnly(false);
    await up.run();
    expect(s.sent).toEqual([A, B]);
  });

  it("stops on a network failure and resumes from that log", async () => {
    const answers: Record<string, number | Error> = { [A]: new Error("offline") };
    const s = setup({ answers });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([A]);
    expect(up.getSnapshot()).toMatchObject({ status: "error", lastError: "offline" });
    delete answers[A];
    await up.run();
    expect(s.sent).toEqual([A, A, B]);
  });

  it("marks a log the Worker refuses for good and goes on; a revoked code stops everything", async () => {
    const s = setup({ trips: [trip(A, 1), trip(B, 2), trip(C, 3)], answers: { [A]: 409, [C]: 401 } });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([A, B, C]);
    expect(up.getSnapshot()).toMatchObject({ status: "codeRejected", refused: { [A]: "e409" }, sentCount: 1 });
    expect(s.removed).toEqual([B]);
    await up.run();
    expect(s.sent).toEqual([A, B, C]);
    expect(await up.connect("bakimtuvodsegap")).toBe("ok");
    await up.run();
    expect(s.sent).toEqual([A, B, C, C]);
  });

  it("never sends a log twice, even when deleting it from the phone failed", async () => {
    const s = setup();
    s.keepDeletes();
    const first = s.make();
    await first.connect("bakimtuvodsegap");
    await first.run();
    expect(first.getSnapshot().uploaded).toEqual({ [A]: 42, [B]: 42 });
    s.snapshot.trips = [trip(B, 2), trip(C, 3)];
    const second = s.make();
    expect(second.getSnapshot()).toMatchObject({ name: "tester-a", status: "idle", sentCount: 2 });
    await second.run();
    expect(s.sent).toEqual([A, B, C]);
    // A is gone from the phone now: its entry is dropped, so the saved list doesn't grow.
    expect(Object.keys(second.getSnapshot().uploaded).sort()).toEqual([B, C]);
  });

  it("disconnecting forgets the code and stops", async () => {
    const s = setup();
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    await up.disconnect();
    s.snapshot.trips = [trip(C, 3)];
    await up.run();
    expect(s.getCode()).toBeNull();
    expect(s.sent).toEqual([A, B]);
    expect(up.getSnapshot().status).toBe("off");
  });
});
