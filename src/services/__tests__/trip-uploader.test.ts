// TripUploader: what gets sent when, and what each Worker answer does (TRIP-LOGGER-SPEC §7.1).
import type { RecorderSnapshot, TripIndexEntry } from "../trip-recorder/trip-recorder";
import { pendingLogs, TripUploader, type HttpResult, type NetworkKind } from "../trip-upload/trip-uploader";

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

function setup(
  opts: {
    trips?: TripIndexEntry[];
    current?: string;
    network?: NetworkKind;
    answers?: Record<string, number | Error>;
    meStatus?: number;
    /** File sizes, bytes (else 1000). */
    sizes?: Record<string, number>;
    /** The Worker's answers to parts, in turn (else 200). */
    partAnswers?: (number | Error)[];
    /** What the uploader saved before, and the code in the keychain. */
    saved?: unknown;
    code?: string;
  } = {},
) {
  const kv = new Map<string, unknown>(opts.saved ? [["trip-upload", opts.saved]] : []);
  let code: string | null = opts.code ?? null;
  /** Requests for logs in parts: method, path, and for parts the range and X-Log-Size; for done, the body. */
  const calls: string[] = [];
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
      putPart: async (url, uri, offset, length, headers): Promise<HttpResult> => {
        expect(headers.Authorization).toBe("Bearer bakimtuvodsegap");
        calls.push(`PUT ${url.replace("https://up.example", "")} ${offset}+${length} ${headers["X-Log-Size"]}`);
        const a = opts.partAnswers?.shift() ?? 200;
        if (a instanceof Error) throw a;
        const n = Number(/parts\/(\d+)/.exec(url)![1]);
        return a === 200 ? { status: 200, body: JSON.stringify({ partNumber: n, etag: `e${n}` }) } : { status: a, body: JSON.stringify({ error: `e${a}` }) };
      },
      sizeOf: (uri) => opts.sizes?.[uri.split("/").pop()!] ?? 1000,
      post: async (url, headers, body): Promise<HttpResult> => {
        expect(headers["X-Log-Size"]).toBeDefined();
        calls.push(`POST ${url.replace("https://up.example", "")}${body ? ` ${body}` : ""}`);
        return url.endsWith("/parts") ? { status: 201, body: JSON.stringify({ uploadId: "u/1" }) } : { status: 201, body: "{}" };
      },
      get: async (url, headers) =>
        opts.meStatus !== undefined
          ? { status: opts.meStatus, body: "{}" }
          : headers.Authorization === "Bearer bakimtuvodsegap"
            ? { status: 200, body: JSON.stringify({ name: "tester-a" }) }
            : { status: 401, body: "{}" },
      now: () => 42,
    });
  return { make, sent, calls, removed, keepDeletes: () => (keepFiles = true), setNetwork: (n: NetworkKind) => (network = n), snapshot, getCode: () => code };
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

  it("asks with the tester name before keeping the code; a no keeps nothing and sends nothing", async () => {
    const s = setup();
    const up = s.make();
    const asked: string[] = [];
    expect(await up.connect("bakimtuvodsegap", async (name) => (asked.push(name), false))).toBe("cancelled");
    expect(asked).toEqual(["tester-a"]);
    expect(s.getCode()).toBeNull();
    await up.run();
    expect(s.sent).toEqual([]);
    expect(up.getSnapshot()).toMatchObject({ name: null, status: "off" });
  });

  it("a Worker error at the code check is a failure, not 'offline'", async () => {
    const s = setup({ meStatus: 500 });
    const up = s.make();
    expect(await up.connect("bakimtuvodsegap")).toBe("failed");
    expect(s.getCode()).toBeNull();
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

  it("a log over 95 MB goes in parts of 50 MB: start, each part, done; then it is deleted", async () => {
    const s = setup({ trips: [trip(A, 1)], sizes: { [A]: 125_800_000 } });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(s.sent).toEqual([]);
    expect(s.calls).toEqual([
      `POST /logs/${A}/parts`,
      `PUT /logs/${A}/parts/1?upload=u%2F1 0+50000000 125800000`,
      `PUT /logs/${A}/parts/2?upload=u%2F1 50000000+50000000 125800000`,
      `PUT /logs/${A}/parts/3?upload=u%2F1 100000000+25800000 125800000`,
      `POST /logs/${A}/parts/done?upload=u%2F1 {"parts":[{"partNumber":1,"etag":"e1"},{"partNumber":2,"etag":"e2"},{"partNumber":3,"etag":"e3"}]}`,
    ]);
    expect(s.removed).toEqual([A]);
    expect(up.getSnapshot()).toMatchObject({ status: "idle", sentCount: 1 });
  });

  it("a part cut off: stopped, the log kept, sent from the start next time", async () => {
    const s = setup({ trips: [trip(A, 1)], sizes: { [A]: 120_000_000 }, partAnswers: [200, new Error("offline")] });
    const up = s.make();
    await up.connect("bakimtuvodsegap");
    await up.run();
    expect(up.getSnapshot()).toMatchObject({ status: "error", lastError: "offline", refused: {} });
    expect(s.removed).toEqual([]);
    await up.run();
    expect(s.calls.filter((c) => c.endsWith("/parts"))).toHaveLength(2);
    expect(s.removed).toEqual([A]);
  });

  it("a log refused for its size before long logs went in parts is sent again; other refusals stay", async () => {
    const cloudflare = "<html>\n<head><title>413 Payload Too Large</title></head>\n<body>";
    const saved = { name: "tester-a", wifiOnly: true, uploaded: {}, refused: { [A]: cloudflare, [B]: "a different log has this name" } };
    const s = setup({ trips: [trip(A, 1), trip(B, 2)], sizes: { [A]: 125_800_000 }, saved, code: "bakimtuvodsegap" });
    const up = s.make();
    expect(up.getSnapshot().refused).toEqual({ [B]: "a different log has this name" });
    await up.run();
    expect(s.removed).toEqual([A]);
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

// The screen counts from the snapshots (the React Compiler kept `uploader.pending()`'s first result: "2 waiting" after
// both were sent, until the screen was opened again).
describe("pendingLogs", () => {
  it("from the two snapshots: not the log being written, not sent, not refused, oldest first", () => {
    const recorder = { trips: [trip(C, 3), trip(B, 2), trip(A, 1)], current: { id: C.slice(16, 22) } } as unknown as RecorderSnapshot;
    expect(pendingLogs(recorder, { uploaded: {}, refused: {} })).toEqual([A, B]);
    expect(pendingLogs(recorder, { uploaded: { [A]: 1 }, refused: {} })).toEqual([B]);
    expect(pendingLogs(recorder, { uploaded: { [A]: 1 }, refused: { [B]: "e409" } })).toEqual([]);
  });
});
