// An in-memory R2 bucket for the Worker's tests (not deployed: nothing imports it but __tests__).
import { createHash } from "node:crypto";

import type { R2Bucket, R2Object, R2PutOptions, R2Range } from "./bucket";

interface Stored {
  data: Uint8Array<ArrayBuffer>;
  uploaded: Date;
  options?: R2PutOptions;
}

async function bytesOf(value: ReadableStream | ArrayBuffer | string | null): Promise<Uint8Array<ArrayBuffer>> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export type TestBucket = R2Bucket & {
  objects: Map<string, Stored>;
  /** The time new objects are stamped with. */
  now: Date;
  text(key: string): string | undefined;
};

export function testBucket(): TestBucket {
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; options?: R2PutOptions; parts: Map<number, Uint8Array> }>();
  const meta = (key: string, o: Stored): R2Object => ({
    key,
    size: o.data.byteLength,
    uploaded: o.uploaded,
    httpEtag: `"${createHash("md5").update(o.data).digest("hex")}"`,
    httpMetadata: o.options?.httpMetadata,
    customMetadata: o.options?.customMetadata,
  });
  const bucket: TestBucket = {
    objects,
    now: new Date("2026-10-10T12:00:00Z"),
    text: (key) => {
      const o = objects.get(key);
      return o && new TextDecoder().decode(o.data);
    },
    async get(key, options?: { range?: R2Range }) {
      const o = objects.get(key);
      if (!o) return null;
      let data = o.data;
      const range = options?.range;
      if (range && "suffix" in range) data = data.slice(data.byteLength - range.suffix);
      else if (range) data = data.slice(range.offset, range.length === undefined ? undefined : range.offset + range.length);
      return { ...meta(key, o), body: new Response(data).body!, text: async () => new TextDecoder().decode(data) };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? meta(key, o) : null;
    },
    async put(key, value, options) {
      const stored = { data: await bytesOf(value), uploaded: bucket.now, options };
      objects.set(key, stored);
      return meta(key, stored);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((k) => meta(k, objects.get(k)!)), truncated: false };
    },
    async createMultipartUpload(key, options) {
      const uploadId = `upload-${uploads.size + 1}`;
      uploads.set(uploadId, { key, options, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = () => {
        const u = uploads.get(uploadId);
        if (!u || u.key !== key) throw new Error("no such upload");
        return u;
      };
      return {
        async uploadPart(partNumber, value) {
          const data = await bytesOf(value);
          upload().parts.set(partNumber, data);
          return { partNumber, etag: `etag-${partNumber}-${data.byteLength}` };
        },
        async complete(parts) {
          const u = upload();
          const chunks = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => u.parts.get(p.partNumber)!);
          const data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let at = 0;
          for (const c of chunks) {
            data.set(c, at);
            at += c.byteLength;
          }
          uploads.delete(uploadId);
          const stored = { data, uploaded: bucket.now, options: u.options };
          objects.set(key, stored);
          return meta(key, stored);
        },
        async abort() {
          uploads.delete(uploadId);
        },
      };
    },
  };
  return bucket;
}
