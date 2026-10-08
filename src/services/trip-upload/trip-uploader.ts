// Trip log upload (TRIP-LOGGER-SPEC §7.1): finished logs go to the upload Worker with the tester's code, opt-in.
// Platform pieces (keychain, network type, file upload) are injected (trip-upload/native.ts) so this stays testable.
import type { KeyValueStore } from "@/obd/vehicle-link-core";
import { normalizeCode } from "@/triplog/upload-protocol";

import type { RecorderSnapshot } from "../trip-recorder/trip-recorder";

export type NetworkKind = "wifi" | "cellular" | "none" | "other";

export interface HttpResult {
  status: number;
  body: string;
}

export interface TripUploaderDeps {
  /** The Worker's base URL, without a trailing slash. */
  baseUrl: string;
  store: KeyValueStore;
  /** Keychain (expo-secure-store): the code is the only secret here. */
  secrets: { get(): Promise<string | null>; set(code: string): Promise<void>; clear(): Promise<void> };
  network(): Promise<NetworkKind>;
  recorder: { getSnapshot(): RecorderSnapshot; tripUri(fileName: string): string };
  /** Deletes a log from the phone once the Worker has it. */
  removeTrip(fileName: string): void;
  /** PUT a local file; resolves with any HTTP status, rejects on network failure. */
  putFile(url: string, fileUri: string, headers: Record<string, string>): Promise<HttpResult>;
  get(url: string, headers: Record<string, string>): Promise<HttpResult>;
  now(): number;
}

export type UploadStatus =
  | "off"
  | "idle"
  | "uploading"
  | "waitingWifi"
  | "offline"
  | "codeRejected"
  | "error";

export interface UploaderSnapshot {
  /** The tester name the Worker knows the code by; null: no code entered. */
  name: string | null;
  wifiOnly: boolean;
  status: UploadStatus;
  /** The file being sent while uploading. */
  current: string | null;
  /** Logs sent (and so deleted from the phone) since upload was first turned on. */
  sentCount: number;
  /** Uploaded logs still on the phone (their deletion failed): file name → time (ms). Never sent again. */
  uploaded: Record<string, number>;
  /** Logs the Worker refused for good (a different file has the name, too large): file name → reason. */
  refused: Record<string, string>;
  lastError: string | null;
}

interface Saved {
  name: string | null;
  wifiOnly: boolean;
  sentCount?: number;
  uploaded: Record<string, number>;
  refused: Record<string, string>;
}

const STORE_KEY = "trip-upload";

export class TripUploader {
  private snapshot: UploaderSnapshot;
  private listeners = new Set<() => void>();
  private active: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: TripUploaderDeps) {
    const saved = deps.store.getJson<Saved>(STORE_KEY);
    this.snapshot = {
      name: saved?.name ?? null,
      wifiOnly: saved?.wifiOnly ?? true,
      status: saved?.name ? "idle" : "off",
      current: null,
      sentCount: saved?.sentCount ?? 0,
      uploaded: saved?.uploaded ?? {},
      refused: saved?.refused ?? {},
      lastError: null,
    };
  }

  getSnapshot = (): UploaderSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Checks a typed code with the Worker and keeps it; uploads start right away. */
  async connect(typed: string): Promise<"ok" | "malformed" | "rejected" | "offline"> {
    const code = normalizeCode(typed);
    if (!code) return "malformed";
    let res: HttpResult;
    try {
      res = await this.deps.get(`${this.deps.baseUrl}/me`, { Authorization: `Bearer ${code}` });
    } catch {
      return "offline";
    }
    if (res.status === 401) return "rejected";
    if (res.status !== 200) return "offline";
    const name = (JSON.parse(res.body) as { name: string }).name;
    await this.deps.secrets.set(code);
    this.update({ name, status: "idle", lastError: null });
    void this.run();
    return "ok";
  }

  /** Forgets the code. What was sent stays sent; the list of sent logs is kept for a reconnect. */
  async disconnect(): Promise<void> {
    this.update({ name: null, status: "off", current: null, lastError: null });
    await this.deps.secrets.clear();
    // A log already on its way finishes; nothing after it starts.
    await this.active;
    this.update({ status: "off", current: null });
  }

  setWifiOnly(wifiOnly: boolean): void {
    this.update({ wifiOnly });
    if (!wifiOnly) void this.run();
  }

  /** Logs waiting to go: finished, not sent, not refused, oldest first. */
  pending(): string[] {
    const snap = this.deps.recorder.getSnapshot();
    return snap.trips
      .filter((t) => t.id !== snap.current?.id && !(t.fileName in this.snapshot.uploaded) && !(t.fileName in this.snapshot.refused))
      .sort((a, b) => a.startUtcMs - b.startUtcMs)
      .map((t) => t.fileName);
  }

  /**
   * Sends what is waiting. Safe to call often (trip end, app foreground, network change): one pass at a time, and a
   * call during a pass makes it go round once more. Resolves when nothing is left to do.
   */
  run(): Promise<void> {
    if (this.active) {
      this.again = true;
      return this.active;
    }
    this.active = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
          // After a failure, wait for the next trigger rather than retrying at once.
        } while (this.again && this.snapshot.status === "idle");
      } finally {
        this.active = null;
      }
    })();
    return this.active;
  }

  private async runOnce(): Promise<void> {
    // A revoked code stays stopped until a new one is entered.
    if (!this.snapshot.name || this.snapshot.status === "codeRejected") return;
    const files = this.pending();
    if (!files.length) return this.update({ status: "idle", current: null });
    const code = await this.deps.secrets.get();
    if (!code) return this.update({ name: null, status: "off" });
    const network = await this.deps.network();
    if (network === "none") return this.update({ status: "offline", current: null });
    if (this.snapshot.wifiOnly && network !== "wifi") return this.update({ status: "waitingWifi", current: null });

    for (const file of files) {
      if (!this.snapshot.name) return;
      this.update({ status: "uploading", current: file });
      let res: HttpResult;
      try {
        res = await this.deps.putFile(`${this.deps.baseUrl}/logs/${file}`, this.deps.recorder.tripUri(file), {
          Authorization: `Bearer ${code}`,
          "Content-Type": "application/octet-stream",
        });
      } catch (e) {
        // Lost the network mid-way: the next trigger retries from this file.
        return this.update({ status: "error", current: null, lastError: e instanceof Error ? e.message : String(e) });
      }
      if (res.status === 200 || res.status === 201) {
        // Marked first: if the deletion fails, the log stays on the phone but is never sent twice.
        this.update({ uploaded: { ...this.snapshot.uploaded, [file]: this.deps.now() }, sentCount: this.snapshot.sentCount + 1 });
        this.deps.removeTrip(file);
        this.update({});
      } else if (res.status === 401) {
        return this.update({ status: "codeRejected", current: null, lastError: null });
      } else if (res.status === 409 || res.status === 413 || res.status === 400) {
        this.update({ refused: { ...this.snapshot.refused, [file]: errorOf(res) } });
      } else {
        return this.update({ status: "error", current: null, lastError: `${res.status} ${errorOf(res)}` });
      }
    }
    this.update({ status: "idle", current: null, lastError: null });
  }

  private update(patch: Partial<UploaderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    const { name, wifiOnly, sentCount } = this.snapshot;
    this.snapshot.uploaded = this.prune(this.snapshot.uploaded);
    this.snapshot.refused = this.prune(this.snapshot.refused);
    const { uploaded, refused } = this.snapshot;
    this.deps.store.setJson(STORE_KEY, { name, wifiOnly, sentCount, uploaded, refused } satisfies Saved);
    this.listeners.forEach((listener) => listener());
  }

  /** Drops entries of logs deleted from the phone, so the saved list doesn't grow forever. */
  private prune<T>(byFile: Record<string, T>): Record<string, T> {
    const kept = new Set(this.deps.recorder.getSnapshot().trips.map((t) => t.fileName));
    return Object.fromEntries(Object.entries(byFile).filter(([file]) => kept.has(file)));
  }
}

function errorOf(res: HttpResult): string {
  try {
    return (JSON.parse(res.body) as { error?: string }).error ?? res.body;
  } catch {
    return res.body.slice(0, 200);
  }
}
