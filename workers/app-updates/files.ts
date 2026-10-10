// Builds and map files (docs/UPDATES-SPEC.md §2): downloads with Range, uploads in one request or in parts.
import { isUploadKey, SINGLE_UPLOAD_MAX } from "../../tools/ota/protocol";

import { json, listAll, type Env, type R2Range } from "./bucket";

const MD5_RE = /^[0-9a-f]{32}$/;

/**
 * The single range of a `Range: bytes=…` header, or `null` for the whole file (no header, or one this server
 * doesn't split: several ranges). `"unsatisfiable"` when it starts past the end.
 */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Math.min(Number(m[2]), size);
    return suffix === 0 ? "unsatisfiable" : { offset: size - suffix, length: suffix };
  }
  const offset = Number(m[1]);
  if (offset >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

/** GET/HEAD of an IPA, APK or map file. iOS background downloads resume with `Range` + `If-Range`. */
export async function serveFile(request: Request, env: Env, key: string, cacheControl: string): Promise<Response> {
  const head = await env.BUCKET.head(key);
  if (!head) return json(404, { error: "not found" });
  const headers: Record<string, string> = {
    "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
    etag: head.httpEtag,
    "last-modified": head.uploaded.toUTCString(),
    "cache-control": cacheControl,
  };
  // A part saved from another version of the file (a forced map rebuild) must start over.
  const ifRange = request.headers.get("if-range");
  const rangeHeader = ifRange && ifRange !== head.httpEtag && ifRange !== headers["last-modified"] ? null : request.headers.get("range");
  const range = parseRange(rangeHeader, head.size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${head.size}` } });
  const length = range ? range.length : head.size;
  const status = range ? 206 : 200;
  if (range) headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
  headers["content-length"] = String(length);
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await env.BUCKET.get(key, range ? { range: range satisfies R2Range } : undefined);
  if (!object) return json(404, { error: "not found" });
  return new Response(object.body, { status, headers });
}

const uploadOptions = (request: Request, md5: string) => ({
  httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" },
  customMetadata: { md5 },
});

/**
 * `/publish/files/<key>` (one request), `/publish/uploads/<key>` (parts: POST starts, PUT `?uploadId&part` sends one,
 * POST `?uploadId` with `{parts}` ends, DELETE `?uploadId` drops it). Every file carries its MD5 (`x-file-md5`), which
 * `files-missing` compares and the app checks after downloading.
 */
export async function upload(request: Request, env: Env, kind: "files" | "uploads", key: string): Promise<Response> {
  if (!isUploadKey(key)) return json(400, { error: "not a build or map file path" });
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");

  if (kind === "files" && request.method === "PUT") {
    const md5 = request.headers.get("x-file-md5") ?? "";
    if (!MD5_RE.test(md5)) return json(400, { error: "x-file-md5 required" });
    const length = Number(request.headers.get("content-length"));
    if (!(length <= SINGLE_UPLOAD_MAX)) return json(413, { error: `over ${SINGLE_UPLOAD_MAX} bytes: upload it in parts` });
    await env.BUCKET.put(key, request.body, uploadOptions(request, md5));
    return json(201, { key });
  }
  if (kind !== "uploads") return json(404, { error: "not found" });

  if (request.method === "POST" && !uploadId) {
    const md5 = request.headers.get("x-file-md5") ?? "";
    if (!MD5_RE.test(md5)) return json(400, { error: "x-file-md5 required" });
    const created = await env.BUCKET.createMultipartUpload(key, uploadOptions(request, md5));
    return json(201, { uploadId: created.uploadId });
  }
  if (!uploadId) return json(400, { error: "uploadId required" });
  const multipart = env.BUCKET.resumeMultipartUpload(key, uploadId);
  if (request.method === "PUT") {
    const part = Number(url.searchParams.get("part"));
    if (!Number.isInteger(part) || part < 1 || part > 10000) return json(400, { error: "part: 1…10000" });
    if (!request.body) return json(400, { error: "empty part" });
    return json(201, await multipart.uploadPart(part, request.body));
  }
  if (request.method === "POST") {
    const { parts } = (await request.json()) as { parts?: { partNumber: number; etag: string }[] };
    if (!Array.isArray(parts) || !parts.length) return json(400, { error: "parts required" });
    const object = await multipart.complete(parts);
    return json(201, { key, size: object.size });
  }
  if (request.method === "DELETE") {
    await multipart.abort();
    return json(200, { key, aborted: true });
  }
  return json(404, { error: "not found" });
}

/** `{files: [{key, size, md5}]}` → `{missing: [key]}`: the files the bucket lacks, or has with another size or MD5. */
export async function filesMissing(request: Request, env: Env): Promise<Response> {
  const { files } = (await request.json()) as { files?: { key: string; size: number; md5: string }[] };
  if (!Array.isArray(files) || !files.every((f) => typeof f?.key === "string" && isUploadKey(f.key))) {
    return json(400, { error: "files: [{key, size, md5}] of build or map paths" });
  }
  // One listing per directory: a map release is ~240 files, more than a Worker may look up one by one.
  const dirs = [...new Set(files.map((f) => f.key.slice(0, f.key.lastIndexOf("/") + 1)))];
  const stored = new Map<string, { size: number; md5?: string }>();
  for (const dir of dirs) {
    for (const o of await listAll(env.BUCKET, dir, ["customMetadata"])) stored.set(o.key, { size: o.size, md5: o.customMetadata?.md5 });
  }
  const missing = files.filter((f) => {
    const have = stored.get(f.key);
    return !have || have.size !== f.size || have.md5 !== f.md5;
  });
  return json(200, { missing: missing.map((f) => f.key) });
}
