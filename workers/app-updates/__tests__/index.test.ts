/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";

import worker, { type Env, type R2Bucket } from "../index";

function fakeBucket(): R2Bucket & { objects: Map<string, { data: ArrayBuffer | string; contentType?: string }> } {
  const objects = new Map<string, { data: ArrayBuffer | string; contentType?: string }>();
  return {
    objects,
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new Response(o.data).body!,
        httpMetadata: { contentType: o.contentType },
        text: async () => (typeof o.data === "string" ? o.data : new TextDecoder().decode(o.data)),
      };
    },
    async put(key, value, options) {
      objects.set(key, { data: value, contentType: options?.httpMetadata?.contentType });
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const TOKEN = "publish-secret";
const RUNTIME = "fp1";
const BUNDLE = new TextEncoder().encode("bundle bytes");
const KEY = createHash("sha256").update(BUNDLE).digest("hex");
const ID = "11111111-2222-3333-4444-555555555555";
const MANIFEST = JSON.stringify({ id: ID, runtimeVersion: RUNTIME, launchAsset: { key: KEY }, assets: [] });
const RECORD = JSON.stringify({ id: ID, manifest: MANIFEST, signature: 'sig="abc", keyid="main"' });

let env: Env & { BUCKET: ReturnType<typeof fakeBucket> };
beforeEach(() => {
  env = { BUCKET: fakeBucket(), PUBLISH_TOKEN: TOKEN };
});

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  worker.fetch(new Request(`https://updates.example${path}`, init), env);
const publish = (path: string, method: string, body: BodyInit, headers: Record<string, string> = {}) =>
  call(`/publish/${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
const phone = (headers: Record<string, string> = {}) =>
  call("/manifest", { headers: { "expo-platform": "ios", "expo-runtime-version": RUNTIME, "expo-protocol-version": "1", ...headers } });

async function publishUpdate() {
  expect((await publish(`assets/${KEY}`, "PUT", BUNDLE, { "content-type": "application/javascript" })).status).toBe(201);
  expect((await publish(`updates/${RUNTIME}/ios/${ID}`, "PUT", RECORD)).status).toBe(201);
}

describe("GET /manifest", () => {
  it("needs the platform and the runtime version", async () => {
    expect((await call("/manifest", { headers: { "expo-runtime-version": RUNTIME } })).status).toBe(400);
    expect((await call("/manifest", { headers: { "expo-platform": "ios" } })).status).toBe(400);
  });

  it("answers 204 while nothing is published for the runtime", async () => {
    const res = await phone();
    expect(res.status).toBe(204);
    expect(res.headers.get("expo-protocol-version")).toBe("1");
  });

  it("serves the latest manifest byte for byte with its signature, as one multipart part", async () => {
    await publishUpdate();
    const res = await phone();
    expect(res.status).toBe(200);
    const boundary = /^multipart\/mixed; boundary=(.+)$/.exec(res.headers.get("content-type") ?? "")?.[1];
    expect(boundary).toBeDefined();
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
    expect(await res.text()).toBe(
      `--${boundary}\r\ncontent-disposition: form-data; name="manifest"\r\ncontent-type: application/json; charset=utf-8\r\n` +
        `expo-signature: sig="abc", keyid="main"\r\n\r\n${MANIFEST}\r\n--${boundary}--\r\n`,
    );
  });

  it("answers 204 to a phone already running the latest update", async () => {
    await publishUpdate();
    expect((await phone({ "expo-current-update-id": ID })).status).toBe(204);
    expect((await phone({ "expo-platform": "android" })).status).toBe(204);
  });

  it("sends a rollback as a signed directive, until the phone runs its embedded JS", async () => {
    const directive = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: "2026-10-10T12:00:00.000Z" } });
    const record = JSON.stringify({ id: "rollback-1", directive, signature: 'sig="r", keyid="main"' });
    expect((await publish(`updates/${RUNTIME}/ios/rollback-1`, "PUT", record)).status).toBe(201);
    const res = await phone({ "expo-current-update-id": ID, "expo-embedded-update-id": "e" });
    expect(await res.text()).toContain(`name="directive"\r\ncontent-type: application/json; charset=utf-8\r\nexpo-signature: sig="r", keyid="main"\r\n\r\n${directive}\r\n`);
    expect((await phone({ "expo-current-update-id": "e", "expo-embedded-update-id": "e" })).status).toBe(204);
  });
});

describe("GET /assets/<key>", () => {
  it("serves a stored file as immutable, with its content type", async () => {
    await publishUpdate();
    const res = await call(`/assets/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BUNDLE);
    expect((await call(`/assets/${"0".repeat(64)}`)).status).toBe(404);
    expect((await call("/assets/..%2Flatest")).status).toBe(404);
  });
});

describe("/publish", () => {
  it("needs the publish token, and is closed while none is set", async () => {
    expect((await call(`/publish/builds/${RUNTIME}/ios`)).status).toBe(401);
    expect((await call(`/publish/builds/${RUNTIME}/ios`, { headers: { authorization: "Bearer wrong-secret-x" } })).status).toBe(401);
    env.PUBLISH_TOKEN = undefined;
    expect((await call(`/publish/builds/${RUNTIME}/ios`, { headers: { authorization: "Bearer " } })).status).toBe(401);
  });

  it("names the asset keys it lacks", async () => {
    await publishUpdate();
    const other = "f".repeat(64);
    const res = await publish("missing", "POST", JSON.stringify({ keys: [KEY, other] }));
    expect(await res.json()).toEqual({ missing: [other] });
    expect((await publish("missing", "POST", JSON.stringify({ keys: ["../x"] }))).status).toBe(400);
  });

  it("refuses a file whose SHA-256 is not its key", async () => {
    expect((await publish(`assets/${"0".repeat(64)}`, "PUT", BUNDLE)).status).toBe(400);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("refuses an update before all its assets are stored, or under another id or runtime", async () => {
    const res = await publish(`updates/${RUNTIME}/ios/${ID}`, "PUT", RECORD);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ missing: [KEY] });
    expect((await publish(`updates/fp2/ios/${ID}`, "PUT", RECORD)).status).toBe(400);
    expect((await publish(`updates/${RUNTIME}/ios/22222222-2222-3333-4444-555555555555`, "PUT", RECORD)).status).toBe(400);
    expect((await phone()).status).toBe(204);
  });

  it("records native builds per runtime", async () => {
    expect((await publish(`builds/${RUNTIME}/ios`, "GET", null as unknown as BodyInit)).status).toBe(404);
    expect((await publish(`builds/${RUNTIME}/ios`, "PUT", JSON.stringify({ commit: "abc" }))).status).toBe(201);
    const res = await publish(`builds/${RUNTIME}/ios`, "GET", null as unknown as BodyInit);
    expect(await res.json()).toMatchObject({ commit: "abc" });
  });
});
