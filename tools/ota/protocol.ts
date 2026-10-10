// What the update Worker (workers/app-updates) and the OTA CLIs agree on: store layout, record shapes, the wire format
// of a manifest response (docs/OTA.md). Pure, no Node imports: the Worker bundles it.

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const isPlatform = (s: string | null | undefined): s is Platform => s === "ios" || s === "android";

/** An asset key: the SHA-256 of the file, hex. */
export const ASSET_KEY_RE = /^[0-9a-f]{64}$/;
/** A runtime version: the fingerprint (hex), or anything path-safe. */
export const RUNTIME_RE = /^[0-9A-Za-z._-]{1,128}$/;
/** An update id (UUID-shaped) or a rollback (`rollback-<ms>`). */
export const RECORD_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|rollback-\d+)$/;

/** A published update: the exact manifest body and its `expo-signature` header. */
export interface UpdateRecord {
  id: string;
  manifest: string;
  signature: string;
}

/** Sends phones of a runtime back to the JS embedded in their build. */
export interface RollbackRecord {
  id: string;
  directive: string;
  signature: string;
}

export type PublishedRecord = UpdateRecord | RollbackRecord;

/** A native build CI made for a runtime: an update for a runtime without one reaches no phone. */
export interface BuildRecord {
  commit: string;
  built: string;
}

/** The fields of a manifest the Worker checks before publishing it. */
export interface UpdateManifestRef {
  id: string;
  runtimeVersion: string;
  launchAsset: { key: string };
  assets: { key: string }[];
}

export const isRollback =(r: PublishedRecord): r is RollbackRecord => "directive" in r;

export function parseRecord(json: unknown): PublishedRecord | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  if (typeof r.id !== "string" || !RECORD_ID_RE.test(r.id) || typeof r.signature !== "string") return null;
  if (typeof r.manifest === "string") return { id: r.id, manifest: r.manifest, signature: r.signature };
  if (typeof r.directive === "string") return { id: r.id, directive: r.directive, signature: r.signature };
  return null;
}

// Bucket keys. `latest/` holds a copy of the record phones get now, so a check costs one read.
export const assetKey = (key: string) => `assets/${key}`;
export const recordKey = (runtime: string, platform: Platform, id: string) => `updates/${runtime}/${platform}/${id}.json`;
export const latestKey = (runtime: string, platform: Platform) => `latest/${runtime}/${platform}.json`;
export const buildKey = (runtime: string, platform: Platform) => `builds/${runtime}/${platform}.json`;

/** What AltStore checks an IPA against (docs/UPDATES-SPEC.md §3): its entitlements and `…UsageDescription` texts. */
export interface AppPermissions {
  entitlements: string[];
  privacy: Record<string, string>;
}

/** A native build of `main` published for the in-app update (docs/UPDATES-SPEC.md §3). */
export interface AppBuild {
  platform: Platform;
  /** `CFBundleShortVersionString` / `versionName`. */
  version: string;
  /** `CFBundleVersion` / `versionCode`: the commit's time in minutes since 2020-01-01 UTC. */
  build: number;
  runtime: string;
  commit: string;
  /** When it was published, ISO. */
  date: string;
  /** The IPA/APK under `apps/<platform>/`. */
  file: string;
  size: number;
  md5: string;
  sha256: string;
  /** The commit titles since the previous build, newest first. */
  notes: string[];
  /** iOS only. */
  permissions?: AppPermissions;
  /** iOS only: `MinimumOSVersion` of the IPA. */
  minOS?: string;
  /**
   * The app as the AltStore source shows it, from app.json and the repo CI ran in: the Worker names no app or repo of
   * its own, so a fork's source is its own.
   */
  name?: string;
  bundleId?: string;
  /** The repo's page. */
  website?: string;
  iconUrl?: string;
}

/** The current map release on the Worker; `previous` is kept until `until` (downloads in progress finish). */
export interface MapsLatest {
  osm_date: string;
  published: string;
  previous?: { osm_date: string; until: string };
}

export const APP_FILE_RE = /^wtfai-\d{1,10}\.(ipa|apk)$/;
export const OSM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A file of a map release, as `tools/tiles` names them (flat: `sprite-ofm@2x.png`, `kyiv.graph.bin`, …). */
export const MAP_FILE_RE = /^[0-9A-Za-z@._-]{1,200}$/;

export const appBuildKey = (platform: Platform, build: number) => `apps/${platform}/${build}.json`;
export const appLatestKey = (platform: Platform) => `apps/${platform}/latest.json`;
export const appFileKey = (platform: Platform, file: string) => `apps/${platform}/${file}`;
export const MAPS_LATEST_KEY = "maps/latest.json";
export const mapFileKey = (osmDate: string, file: string) => `maps/${osmDate}/${file}`;

/** Files up to this size go in one request; bigger ones in parts of `UPLOAD_PART_SIZE` (the Worker takes ≤ 100 MB). */
export const SINGLE_UPLOAD_MAX = 64 * 1024 * 1024;
/** R2 wants every part but the last the same size, at least 5 MiB. */
export const UPLOAD_PART_SIZE = 32 * 1024 * 1024;

/** A bucket key that the build and map uploads may write: `apps/<platform>/<file>` or `maps/<osm_date>/<file>`. */
export function isUploadKey(key: string): boolean {
  const [top, a, b, ...rest] = key.split("/");
  if (rest.length || b === undefined) return false;
  if (top === "apps") return isPlatform(a) && APP_FILE_RE.test(b) && b.endsWith(a === "ios" ? ".ipa" : ".apk");
  if (top === "maps") return OSM_DATE_RE.test(a) && MAP_FILE_RE.test(b);
  return false;
}

export function parseAppBuild(json: unknown): AppBuild | null {
  if (typeof json !== "object" || json === null) return null;
  const b = json as Partial<AppBuild>;
  const ok =
    isPlatform(b.platform) &&
    typeof b.version === "string" &&
    Number.isSafeInteger(b.build) &&
    (b.build ?? 0) > 0 &&
    typeof b.runtime === "string" &&
    RUNTIME_RE.test(b.runtime) &&
    typeof b.commit === "string" &&
    typeof b.file === "string" &&
    APP_FILE_RE.test(b.file) &&
    Number.isSafeInteger(b.size) &&
    typeof b.md5 === "string" &&
    typeof b.sha256 === "string" &&
    Array.isArray(b.notes) &&
    b.notes.every((n) => typeof n === "string");
  if (!ok) return null;
  const p = b.permissions;
  if (p !== undefined && (!Array.isArray(p.entitlements) || typeof p.privacy !== "object" || p.privacy === null)) return null;
  return b as AppBuild;
}

/** `multipart/mixed` body with one part per record (protocol v1): the client checks each part's signature. */
export function multipartBody(boundary: string, parts: { name: "manifest" | "directive"; body: string; signature: string }[]): string {
  const crlf = "\r\n";
  return (
    parts
      .map(
        (p) =>
          `--${boundary}${crlf}` +
          `content-disposition: form-data; name="${p.name}"${crlf}` +
          `content-type: application/json; charset=utf-8${crlf}` +
          `expo-signature: ${p.signature}${crlf}${crlf}` +
          p.body +
          crlf,
      )
      .join("") + `--${boundary}--${crlf}`
  );
}
