// OTA update server (docs/OTA.md): the Expo Updates protocol v1 over an R2 bucket. Phones read; CI publishes with the
// publish token. Everything served was signed in CI (tools/ota/prepare.ts), so this Worker holds no signing key and
// a leaked publish token cannot ship code to phones.
//
//   GET  /manifest                              the latest update or rollback for the phone's runtime and platform
//   GET  /assets/<key>                          a file of an update (immutable)
//   POST /publish/missing  {keys}               → {missing}: which asset keys the bucket lacks
//   PUT  /publish/assets/<key>                  stores a file; its SHA-256 must be the key
//   PUT  /publish/builds/<runtime>/<platform>   a native build of that runtime exists (written by the build jobs)
//   GET  /publish/builds/<runtime>/<platform>   200 the build record, 404 none
//   PUT  /publish/updates/<runtime>/<platform>/<id>  stores the record and makes it the latest; an update's assets must
//                                               all be stored already
import {
  ASSET_KEY_RE,
  assetKey,
  buildKey,
  isPlatform,
  isRollback,
  latestKey,
  multipartBody,
  parseRecord,
  recordKey,
  RECORD_ID_RE,
  RUNTIME_RE,
  type BuildRecord,
  type UpdateManifestRef,
} from "../../tools/ota/protocol";

/** The slice of the R2 binding used here (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). */
export interface R2Object {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
}
export interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface Env {
  BUCKET: R2Bucket;
  /** `npx wrangler secret put PUBLISH_TOKEN`; the same value is CI's OTA_PUBLISH_TOKEN secret. */
  PUBLISH_TOKEN?: string;
}

const PROTOCOL_HEADERS = { "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** "No update for you": an empty multipart answer. */
const noUpdate = () => new Response(null, { status: 204, headers: PROTOCOL_HEADERS });

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function authorized(request: Request, env: Env): boolean {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const want = env.PUBLISH_TOKEN ?? "";
  if (!want || token.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= token.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function storedAssetKeys(bucket: R2Bucket): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "assets/", cursor });
    for (const o of page.objects) keys.add(o.key.slice("assets/".length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function manifest(request: Request, env: Env): Promise<Response> {
  const platform = request.headers.get("expo-platform");
  const runtime = request.headers.get("expo-runtime-version");
  if (!isPlatform(platform)) return json(400, { error: "expo-platform must be ios or android" });
  if (!runtime || !RUNTIME_RE.test(runtime)) return json(400, { error: "no expo-runtime-version" });

  const stored = await env.BUCKET.get(latestKey(runtime, platform));
  const record = stored ? parseRecord(JSON.parse(await stored.text())) : null;
  if (!record) return noUpdate();

  const boundary = `wtf-${crypto.randomUUID()}`;
  const headers = { ...PROTOCOL_HEADERS, "content-type": `multipart/mixed; boundary=${boundary}` };
  if (isRollback(record)) {
    // Already on the embedded JS: nothing to roll back.
    if (request.headers.get("expo-current-update-id") === request.headers.get("expo-embedded-update-id")) return noUpdate();
    return new Response(multipartBody(boundary, [{ name: "directive", body: record.directive, signature: record.signature }]), { headers });
  }
  if (request.headers.get("expo-current-update-id") === record.id) return noUpdate();
  return new Response(multipartBody(boundary, [{ name: "manifest", body: record.manifest, signature: record.signature }]), { headers });
}

async function asset(key: string, env: Env): Promise<Response> {
  if (!ASSET_KEY_RE.test(key)) return json(404, { error: "not found" });
  const object = await env.BUCKET.get(assetKey(key));
  if (!object) return json(404, { error: "not found" });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

async function publish(request: Request, env: Env, parts: string[]): Promise<Response> {
  if (!authorized(request, env)) return json(401, { error: "publish token required" });
  const [what, a, b, c] = parts;

  if (what === "missing" && request.method === "POST" && parts.length === 1) {
    const { keys } = (await request.json()) as { keys?: unknown };
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string" && ASSET_KEY_RE.test(k))) return json(400, { error: "keys: asset keys" });
    const stored = await storedAssetKeys(env.BUCKET);
    return json(200, { missing: keys.filter((k) => !stored.has(k)) });
  }

  if (what === "assets" && request.method === "PUT" && parts.length === 2 && ASSET_KEY_RE.test(a)) {
    const body = await request.arrayBuffer();
    if ((await sha256Hex(body)) !== a) return json(400, { error: "the file's SHA-256 is not its key" });
    await env.BUCKET.put(assetKey(a), body, { httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" } });
    return json(201, { key: a });
  }

  if (what === "builds" && parts.length === 3 && RUNTIME_RE.test(a) && isPlatform(b)) {
    if (request.method === "GET") {
      const stored = await env.BUCKET.get(buildKey(a, b));
      return stored ? json(200, JSON.parse(await stored.text())) : json(404, { error: "no build of this runtime" });
    }
    if (request.method === "PUT") {
      const record = (await request.json()) as Partial<BuildRecord>;
      if (typeof record.commit !== "string") return json(400, { error: "commit required" });
      const stored: BuildRecord = { commit: record.commit, built: new Date().toISOString() };
      await env.BUCKET.put(buildKey(a, b), JSON.stringify(stored));
      return json(201, stored);
    }
  }

  if (what === "updates" && request.method === "PUT" && parts.length === 4 && RUNTIME_RE.test(a) && isPlatform(b) && RECORD_ID_RE.test(c)) {
    const text = await request.text();
    const record = parseRecord(JSON.parse(text));
    if (!record || record.id !== c) return json(400, { error: "not a record with this id" });
    if (!isRollback(record)) {
      // A phone that gets the manifest downloads every asset at once: all of them must be here first.
      const m = JSON.parse(record.manifest) as UpdateManifestRef;
      if (m.id !== c || m.runtimeVersion !== a) return json(400, { error: "the manifest is for another id or runtime" });
      const stored = await storedAssetKeys(env.BUCKET);
      const missing = [m.launchAsset, ...m.assets].map((x) => x.key).filter((k) => !stored.has(k));
      if (missing.length) return json(409, { error: "assets not uploaded", missing });
    }
    await env.BUCKET.put(recordKey(a, b, c), text);
    await env.BUCKET.put(latestKey(a, b), text);
    return json(201, { id: c, latest: true });
  }

  return json(404, { error: "not found" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [first, ...rest] = new URL(request.url).pathname.split("/").filter(Boolean);
    if (first === "manifest" && request.method === "GET" && rest.length === 0) return manifest(request, env);
    if (first === "assets" && request.method === "GET" && rest.length === 1) return asset(rest[0], env);
    if (first === "publish") return publish(request, env, rest);
    return json(404, { error: "not found" });
  },
};
