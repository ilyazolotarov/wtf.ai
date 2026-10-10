// Update server (docs/OTA.md, docs/UPDATES-SPEC.md): the Expo Updates protocol v1 for JS updates, native builds for
// the in-app update, our AltStore source and the offline maps, over one R2 bucket. Phones read; CI publishes with the
// publish token. Every JS update served was signed in CI (tools/ota/prepare.ts), so this Worker holds no signing key
// and a leaked publish token cannot ship code to phones.
//
//   GET  /manifest                              the latest update or rollback for the phone's runtime and platform
//   GET  /assets/<key>                          a file of an update (immutable)
//   GET  /apps/<platform>/latest.json           the newest native build; /apps/<platform>/<file> its IPA/APK (Range)
//   GET  /altstore.json                         the AltStore source (the kept iOS builds)
//   GET  /maps/latest.json                      the current map release; /maps/<osm_date>/<file> its files (Range)
//   POST /publish/missing  {keys}               → {missing}: which asset keys the bucket lacks
//   PUT  /publish/assets/<key>                  stores a file; its SHA-256 must be the key
//   PUT  /publish/builds/<runtime>/<platform>   a native build of that runtime exists (written by the build jobs)
//   GET  /publish/builds/<runtime>/<platform>   200 the build record, 404 none
//   PUT  /publish/updates/<runtime>/<platform>/<id>  stores the record and makes it the latest; an update's assets must
//                                               all be stored already
//   PUT  /publish/files/<key>, /publish/uploads/<key>  a build or map file, in one request or in parts (files.ts)
//   POST /publish/files-missing {files}         → {missing}: which build or map files the bucket lacks
//   PUT  /publish/apps/<platform>               a build's record, after its file
//   PUT  /publish/maps/<osm_date>               makes an uploaded map release the current one
//   POST /publish/prune[?dry=1]                 removes what no phone needs (prune.ts): daily by cron, and by the CLIs
//                                               after a publish, in a request of its own
import {
  appFileKey,
  ASSET_KEY_RE,
  assetKey,
  buildKey,
  isPlatform,
  isRollback,
  latestKey,
  mapFileKey,
  multipartBody,
  OSM_DATE_RE,
  parseRecord,
  recordKey,
  RECORD_ID_RE,
  RUNTIME_RE,
  type BuildRecord,
  type UpdateManifestRef,
} from "../../tools/ota/protocol";

import { publishApp, serveAltStoreSource, serveLatestApp } from "./apps";
import { json, listAll, type Env } from "./bucket";
import { filesMissing, serveFile, upload } from "./files";
import { publishMaps, serveMapsLatest } from "./maps";
import { prune } from "./prune";

export type { Env, R2Bucket } from "./bucket";

const PROTOCOL_HEADERS = { "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" };

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

async function storedAssetKeys(env: Env): Promise<Set<string>> {
  return new Set((await listAll(env.BUCKET, "assets/")).map((o) => o.key.slice("assets/".length)));
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
    const stored = await storedAssetKeys(env);
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
      const stored = await storedAssetKeys(env);
      const missing = [m.launchAsset, ...m.assets].map((x) => x.key).filter((k) => !stored.has(k));
      if (missing.length) return json(409, { error: "assets not uploaded", missing });
    }
    await env.BUCKET.put(recordKey(a, b, c), text);
    await env.BUCKET.put(latestKey(a, b), text);
    return json(201, { id: c, latest: true });
  }

  if ((what === "files" || what === "uploads") && parts.length > 1) return upload(request, env, what, parts.slice(1).join("/"));
  if (what === "files-missing" && request.method === "POST" && parts.length === 1) return filesMissing(request, env);
  if (what === "apps" && request.method === "PUT" && parts.length === 2 && isPlatform(a)) return publishApp(request, env, a);
  if (what === "maps" && request.method === "PUT" && parts.length === 2 && OSM_DATE_RE.test(a)) return publishMaps(env, a, new Date());
  if (what === "prune" && request.method === "POST" && parts.length === 1) {
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    const removed = await prune(env, new Date(), dry);
    return json(200, { dry, removed });
  }

  return json(404, { error: "not found" });
}

/** Builds and maps: immutable names for builds; a map release can be rebuilt under its date (a forced run). */
const BUILD_CACHE = "public, max-age=31536000, immutable";
const MAP_CACHE = "public, max-age=3600";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let segments: string[];
    try {
      // Map files have `@` in their names (`sprite-ofm@2x.png`), which the app sends encoded.
      segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return json(400, { error: "bad path" });
    }
    const [first, ...rest] = segments;
    const read = request.method === "GET" || request.method === "HEAD";
    if (first === "manifest" && request.method === "GET" && rest.length === 0) return manifest(request, env);
    if (first === "assets" && request.method === "GET" && rest.length === 1) return asset(rest[0], env);
    if (first === "altstore.json" && read && rest.length === 0) return serveAltStoreSource(request, env);
    if (first === "apps" && read && rest.length === 2 && isPlatform(rest[0])) {
      if (rest[1] === "latest.json") return serveLatestApp(env, rest[0]);
      return serveFile(request, env, appFileKey(rest[0], rest[1]), BUILD_CACHE);
    }
    if (first === "maps" && read && rest.length === 1 && rest[0] === "latest.json") return serveMapsLatest(env);
    if (first === "maps" && read && rest.length === 2 && OSM_DATE_RE.test(rest[0])) {
      return serveFile(request, env, mapFileKey(rest[0], rest[1]), MAP_CACHE);
    }
    if (first === "publish") return publish(request, env, rest);
    return json(404, { error: "not found" });
  },

  /** Daily (wrangler.toml `[triggers]`): the bucket stays within the free tier even when nothing is published. */
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await prune(env, new Date());
  },
};
