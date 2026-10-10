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
