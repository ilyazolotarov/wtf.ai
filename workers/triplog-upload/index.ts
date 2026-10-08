// Trip log upload Worker (TRIP-LOGGER-SPEC §7.1). The app PUTs a finished log with its tester's code; the Worker
// writes it to the private bucket through its R2 binding, so no storage keys ever ship in the app.
//
//   GET /me                    → 200 {name} for a known code, else 401
//   PUT /logs/<trip file name> → 201 stored, 200 already there (same size), 409 a different file has that name
//
// A code can only add logs: nothing here lists, reads or deletes. Codes are kept as SHA-256 hashes
// (`testers/<hash>.json`, written by `npm run testers:add`), so even the bucket never holds one.
import { MAX_UPLOAD_BYTES, normalizeCode, testerKey, TRIP_FILE_RE, uploadKey, type TesterRecord } from "../../src/triplog/upload-protocol";

/** The slice of the R2 binding used here (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). */
interface R2Bucket {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: ReadableStream | null, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const tester = await testerOf(request, env);
    if (!tester) return json(401, { error: "unknown code" });

    if (request.method === "GET" && url.pathname === "/me") return json(200, { name: tester.name });

    const file = /^\/logs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method !== "PUT" || !file) return json(404, { error: "not found" });
    if (!TRIP_FILE_RE.test(file)) return json(400, { error: "not a trip log name" });
    const size = Number(request.headers.get("content-length"));
    if (!Number.isFinite(size) || size <= 0) return json(411, { error: "content-length required" });
    if (size > MAX_UPLOAD_BYTES) return json(413, { error: "too large" });

    // A log never changes after the trip ends: the same name and size is a retry, a different size is not ours to
    // overwrite.
    const key = uploadKey(tester, file);
    const existing = await env.BUCKET.head(key);
    if (existing) return existing.size === size ? json(200, { key, stored: false }) : json(409, { error: "a different log has this name" });

    await env.BUCKET.put(key, request.body, { customMetadata: { tester: tester.name, uploaded: new Date().toISOString() } });
    return json(201, { key, stored: true });
  },
};
