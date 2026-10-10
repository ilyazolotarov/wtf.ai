// The slice of the R2 binding the update Worker uses (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
// and what its modules share.

export interface R2Object {
  key: string;
  size: number;
  uploaded: Date;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text(): Promise<string>;
}

export type R2Range = { offset: number; length?: number } | { suffix: number };

export interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | string): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
  abort(): Promise<void>;
}

export interface R2Bucket {
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | string | null, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{
    objects: R2Object[];
    truncated: boolean;
    cursor?: string;
  }>;
  createMultipartUpload(key: string, options?: R2PutOptions): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

export interface Env {
  BUCKET: R2Bucket;
  /** `npx wrangler secret put PUBLISH_TOKEN`; the same value is CI's OTA_PUBLISH_TOKEN secret. */
  PUBLISH_TOKEN?: string;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/** Every object under `prefix`, all pages. */
export async function listAll(bucket: R2Bucket, prefix: string, include?: ("httpMetadata" | "customMetadata")[]): Promise<R2Object[]> {
  const all: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include });
    all.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all;
}

export async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const stored = await bucket.get(key);
  if (!stored) return null;
  try {
    return JSON.parse(await stored.text()) as T;
  } catch {
    return null;
  }
}

/** R2 deletes up to 1000 keys per call. */
export async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}
