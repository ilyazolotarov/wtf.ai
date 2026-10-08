// A minimal S3 client (AWS Signature Version 4, no dependencies) for the private trip log bucket (Cloudflare R2).
// Credentials come from .env.local (git-ignored; names in .env.example): S3_API_ENDPOINT, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, S3_TRIPLOGS_BUCKET_NAME, and S3_REGION where the store wants one (R2: "auto", the default).
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env.local");

export type Remote = { key: string; md5: string; size: number; modified: string };
export type Creds = { endpoint: string; bucket: string; keyId: string; secret: string; region: string };

export const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();
/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export const encPath = (key: string) => key.split("/").map(enc).join("/");

export function credentials(): Creds {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const need = ["S3_API_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_TRIPLOGS_BUCKET_NAME"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`.env.local lacks ${missing.join(", ")} (see .env.example)`);
  const env = (k: string) => process.env[k]!.trim();
  // Host only: the endpoint may be pasted with https:// or with the bucket after it.
  const endpoint = new URL(/^https?:\/\//.test(env("S3_API_ENDPOINT")) ? env("S3_API_ENDPOINT") : `https://${env("S3_API_ENDPOINT")}`).host;
  return {
    endpoint,
    bucket: env("S3_TRIPLOGS_BUCKET_NAME"),
    keyId: env("S3_ACCESS_KEY_ID"),
    secret: env("S3_SECRET_ACCESS_KEY"),
    region: process.env.S3_REGION?.trim() || "auto",
  };
}

/** One signed S3 request (AWS Signature Version 4), path-style: /<bucket>/<key>. */
export async function s3(c: Creds, method: string, key: string, opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}) {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = now.slice(0, 8);
  const uri = `/${enc(c.bucket)}${key ? "/" + encPath(key) : ""}`;
  const query = Object.entries(opts.query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const headers: Record<string, string> = { host: c.endpoint, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": now, ...opts.headers };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const canonical = [method, uri, query, names.map((h) => `${h}:${lower[h]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${day}/${c.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", now, scope, sha256(canonical)].join("\n");
  const signing = hmac(hmac(hmac(hmac("AWS4" + c.secret, day), c.region), "s3"), "aws4_request");
  const auth = `AWS4-HMAC-SHA256 Credential=${c.keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(signing, toSign).toString("hex")}`;
  const { host: _host, ...sent } = headers;
  const res = await fetch(`https://${c.endpoint}${uri}${query ? "?" + query : ""}`, {
    method,
    headers: { ...sent, Authorization: auth },
    body: opts.body ? new Uint8Array(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${key || "/"}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function listRemote(c: Creds, prefix: string): Promise<Map<string, Remote>> {
  const out = new Map<string, Remote>();
  let token = "";
  do {
    const xml = await (await s3(c, "GET", "", { query: { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) } })).text();
    const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (t: string) => unxml(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(item)?.[1] ?? "");
      const key = tag("Key").slice(prefix.length);
      out.set(key, { key, md5: tag("ETag").replace(/"/g, ""), size: Number(tag("Size")), modified: tag("LastModified") });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? "") : "";
  } while (token);
  return out;
}

