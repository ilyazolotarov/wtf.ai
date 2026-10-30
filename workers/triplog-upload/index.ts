// Trip log upload Worker (TRIP-LOGGER-SPEC §7.1). The app PUTs a finished log with its tester's code; the Worker
// writes it to the private bucket through its R2 binding, so no storage keys ever ship in the app.
//
//   GET  /me                                        → 200 {name} for a known code, else 401
//   PUT  /logs/<trip file name>                     → 201 stored, 200 already there (same size), 409 a different file
//                                                     has that name, 413 over MAX_UPLOAD_BYTES (send it in parts)
//   A log over MAX_UPLOAD_BYTES in parts (R2 multipart), each request with `X-Log-Size: <the log's bytes>`:
//   POST /logs/<file>/parts                         → 201 {uploadId}; 200 / 409 as for one PUT
//   PUT  /logs/<file>/parts/<n>?upload=<uploadId>   → 200 {partNumber, etag}; part n of `partSize`, 1-based
//   POST /logs/<file>/parts/done?upload=<uploadId>  → 201 stored, from body {parts: [{partNumber, etag}]}; 200 / 409
//
// A code can only add logs: nothing here lists, reads or deletes (but a log just put together from parts that don't
// add up to its size). Codes are kept as SHA-256 hashes (`testers/<hash>.json`, written by `npm run testers:add`), so
// even the bucket never holds one.
import {
  MAX_LOG_BYTES,
  MAX_UPLOAD_BYTES,
  normalizeCode,
  partCount,
  partSize,
  testerKey,
  TRIP_FILE_RE,
  uploadKey,
  type TesterRecord,
} from "../../src/triplog/upload-protocol";

interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** The slice of R2's multipart upload used here. */
interface R2MultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<{ size: number }>;
  abort(): Promise<void>;
}

/** The slice of the R2 binding used here (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). */
interface R2Bucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: ReadableStream | null, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

interface Env {
  BUCKET: R2Bucket;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function testerOf(request: Request, env: Env): Promise<TesterRecord | null> {
  const code = normalizeCode(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!code) return null;
  const record = await env.BUCKET.get(testerKey(await sha256Hex(code)));
  return record ? (JSON.parse(await record.text()) as TesterRecord) : null;
}

const metadata = (tester: TesterRecord) => ({ tester: tester.name, uploaded: new Date().toISOString() });

/**
 * A log never changes after the trip ends: one already under its name with the same size is a retry, a different size
 * is not ours to overwrite.
 */
async function already(env: Env, key: string, size: number): Promise<Response | null> {
  const existing = await env.BUCKET.head(key);
  if (!existing) return null;
  return existing.size === size ? json(200, { key, stored: false }) : json(409, { error: "a different log has this name" });
}

async function whole(request: Request, env: Env, tester: TesterRecord, key: string): Promise<Response> {
  if (request.method !== "PUT") return json(404, { error: "not found" });
  const size = Number(request.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) return json(411, { error: "content-length required" });
  if (size > MAX_UPLOAD_BYTES) return json(413, { error: "too large for one request: send it in parts" });
  const done = await already(env, key, size);
  if (done) return done;
  await env.BUCKET.put(key, request.body, { customMetadata: metadata(tester) });
  return json(201, { key, stored: true });
}

async function inParts(request: Request, env: Env, tester: TesterRecord, key: string, step: string | undefined, url: URL): Promise<Response> {
  const size = Number(request.headers.get("x-log-size"));
  if (!Number.isInteger(size) || size <= 0) return json(400, { error: "x-log-size required" });
  if (size > MAX_LOG_BYTES) return json(413, { error: "over 2 GB" });
  if (step === undefined) {
    if (request.method !== "POST") return json(404, { error: "not found" });
    const done = await already(env, key, size);
    if (done) return done;
    const upload = await env.BUCKET.createMultipartUpload(key, { customMetadata: metadata(tester) });
    return json(201, { uploadId: upload.uploadId });
  }
  const uploadId = url.searchParams.get("upload");
  if (!uploadId) return json(400, { error: "upload id required" });
  // The key is the tester's own: an upload id can't reach another tester's log.
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  if (step === "done") {
    if (request.method !== "POST") return json(404, { error: "not found" });
    const parts = ((await request.json().catch(() => null)) as { parts?: UploadedPart[] } | null)?.parts;
    if (!Array.isArray(parts) || parts.length !== partCount(size)) return json(400, { error: "parts missing" });
    const done = await already(env, key, size);
    if (done) {
      await upload.abort().catch(() => {});
      return done;
    }
    let stored: { size: number };
    try {
      stored = await upload.complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
    } catch (e) {
      return json(400, { error: `parts don't fit together: ${e instanceof Error ? e.message : String(e)}` });
    }
    if (stored.size !== size) {
      await env.BUCKET.delete(key);
      return json(400, { error: `parts add up to ${stored.size} bytes, not ${size}` });
    }
    return json(201, { key, stored: true });
  }
  if (request.method !== "PUT") return json(404, { error: "not found" });
  const n = Number(step);
  const length = Number(request.headers.get("content-length"));
  if (!partSize(size, n) || length !== partSize(size, n) || !request.body) return json(400, { error: "not a part of this log" });
  try {
    const part = await upload.uploadPart(n, request.body);
    return json(200, { partNumber: part.partNumber, etag: part.etag });
  } catch (e) {
    return json(404, { error: `no such upload: ${e instanceof Error ? e.message : String(e)}` });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const tester = await testerOf(request, env);
    if (!tester) return json(401, { error: "unknown code" });

    if (request.method === "GET" && url.pathname === "/me") return json(200, { name: tester.name });

    const route = /^\/logs\/([^/]+)(\/parts(?:\/(\d+|done))?)?$/.exec(url.pathname);
    if (!route) return json(404, { error: "not found" });
    const [, file, parts, step] = route;
    if (!TRIP_FILE_RE.test(file)) return json(400, { error: "not a trip log name" });
    const key = uploadKey(tester, file);
    return parts ? inParts(request, env, tester, key, step, url) : whole(request, env, tester, key);
  },
};
