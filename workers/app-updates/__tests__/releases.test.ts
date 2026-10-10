/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";

import { UPLOAD_PART_SIZE } from "../../../tools/ota/protocol";
import { parseRange } from "../files";
import worker, { type Env } from "../index";
import { testBucket, type TestBucket } from "../test-bucket";

const TOKEN = "publish-secret";
let env: Env & { BUCKET: TestBucket };
beforeEach(() => {
  env = { BUCKET: testBucket(), PUBLISH_TOKEN: TOKEN };
});

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  worker.fetch(new Request(`https://updates.example${path}`, init), env);
const publish = (path: string, method: string, body?: BodyInit, headers: Record<string, string> = {}) =>
  call(`/publish/${path}`, { method, body, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
const md5 = (data: Uint8Array | string) => createHash("md5").update(data).digest("hex");

async function putFile(key: string, data: Uint8Array<ArrayBuffer> | string, contentType = "application/octet-stream") {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const res = await publish(`files/${key}`, "PUT", body, {
    "x-file-md5": md5(body),
    "content-type": contentType,
    "content-length": String(body.byteLength),
  });
  expect(res.status).toBe(201);
}

const IPA = new TextEncoder().encode("ipa bytes ".repeat(100));
const buildRecord = (build: number, extra: Record<string, unknown> = {}) => ({
  platform: "ios",
  version: "1.0.0",
  build,
  runtime: `fp${build}`,
  commit: `c${build}`,
  file: `wtfai-${build}.ipa`,
  size: IPA.byteLength,
  md5: md5(IPA),
  sha256: "s",
  notes: [`change ${build}`],
  permissions: { entitlements: [], privacy: { NSLocationWhenInUseUsageDescription: "Where you are." } },
  minOS: "16.4",
  name: "wtf.ai",
  bundleId: "ai.example.app",
  website: "https://git.example/someone/app",
  iconUrl: "https://git.example/icon.png",
  ...extra,
});
async function publishBuild(build: number) {
  await putFile(`apps/ios/wtfai-${build}.ipa`, IPA);
  const res = await publish("apps/ios", "PUT", JSON.stringify(buildRecord(build)));
  expect(res.status).toBe(201);
  return res;
}

describe("parseRange", () => {
  it("reads one range of bytes", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=10-19", 100)).toEqual({ offset: 10, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=95-200", 100)).toEqual({ offset: 95, length: 5 });
    expect(parseRange("bytes=-30", 100)).toEqual({ offset: 70, length: 30 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    // Several ranges, or nonsense: the whole file.
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
  });
});

describe("builds", () => {
  it("serves the newest record and the file, resuming with Range unless If-Range names another version", async () => {
    expect((await call("/apps/ios/latest.json")).status).toBe(404);
    await publishBuild(100);
    const latest = await (await call("/apps/ios/latest.json")).json();
    expect(latest).toMatchObject({ build: 100, file: "wtfai-100.ipa", notes: ["change 100"] });
    expect(typeof latest.date).toBe("string");

    const whole = await call("/apps/ios/wtfai-100.ipa");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(IPA);
    const etag = whole.headers.get("etag")!;

    const part = await call("/apps/ios/wtfai-100.ipa", { headers: { range: "bytes=10-", "if-range": etag } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-${IPA.byteLength - 1}/${IPA.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(IPA.slice(10));

    const changed = await call("/apps/ios/wtfai-100.ipa", { headers: { range: "bytes=10-", "if-range": '"other"' } });
    expect(changed.status).toBe(200);
    expect((await call("/apps/ios/wtfai-100.ipa", { headers: { range: "bytes=5000-" } })).status).toBe(416);
    expect((await call("/apps/ios/wtfai-100.ipa", { method: "HEAD" })).headers.get("content-length")).toBe(String(IPA.byteLength));
  });

  it("refuses a record before its file, or with another size, platform or file type", async () => {
    expect((await publish("apps/ios", "PUT", JSON.stringify(buildRecord(100)))).status).toBe(409);
    await putFile("apps/ios/wtfai-100.ipa", IPA);
    expect((await publish("apps/ios", "PUT", JSON.stringify(buildRecord(100, { size: 1 })))).status).toBe(409);
    expect((await publish("apps/android", "PUT", JSON.stringify(buildRecord(100)))).status).toBe(400);
    expect((await publish("apps/ios", "PUT", JSON.stringify(buildRecord(100, { file: "wtfai-100.apk" })))).status).toBe(400);
    expect((await call("/apps/ios/latest.json")).status).toBe(404);
  });

  it("keeps latest at the highest build number", async () => {
    await publishBuild(200);
    const older = await publishBuild(150);
    expect(await older.json()).toEqual({ build: 150, latest: false });
    expect(await (await call("/apps/ios/latest.json")).json()).toMatchObject({ build: 200 });
  });

  it("serves the AltStore source: the kept builds newest first, with the newest's permissions", async () => {
    // Nothing to describe the app with yet.
    expect((await call("/altstore.json")).status).toBe(404);
    await publishBuild(100);
    await publishBuild(101);
    const source = await (await call("/altstore.json")).json();
    expect(source.apps).toHaveLength(1);
    const app = source.apps[0];
    expect(app.bundleIdentifier).toBe("ai.example.app");
    expect(app.iconURL).toBe("https://git.example/icon.png");
    expect(source.website).toBe("https://git.example/someone/app");
    expect(app.versions.map((v: { buildVersion: string }) => v.buildVersion)).toEqual(["101", "100"]);
    expect(app.versions[0]).toMatchObject({
      version: "1.0.0",
      downloadURL: "https://updates.example/apps/ios/wtfai-101.ipa",
      size: IPA.byteLength,
      minOSVersion: "16.4",
      localizedDescription: "• change 101",
    });
    expect(app.appPermissions).toEqual({ entitlements: [], privacy: { NSLocationWhenInUseUsageDescription: "Where you are." } });
  });
});

describe("file uploads", () => {
  it("takes files only under apps/ and maps/, and only small ones in one request", async () => {
    const bad = await publish("files/assets/x", "PUT", "x", { "x-file-md5": md5("x") });
    expect(bad.status).toBe(400);
    expect((await publish("files/apps/ios/wtfai-1.apk", "PUT", "x", { "x-file-md5": md5("x") })).status).toBe(400);
    expect((await publish("files/maps/2026-10-08/kyiv.pmtiles", "PUT", "x")).status).toBe(400);
    const big = await publish("files/maps/2026-10-08/kyiv.pmtiles", "PUT", "x", { "x-file-md5": md5("x"), "content-length": String(65 * 1024 * 1024) });
    expect(big.status).toBe(413);
  });

  it("puts a big file together from its parts", async () => {
    const key = "maps/2026-10-08/ukraine.pmtiles";
    const data = new Uint8Array(UPLOAD_PART_SIZE + 10).map((_, i) => i % 251);
    const started = await publish(`uploads/${key}`, "POST", undefined, { "x-file-md5": md5(data) });
    const { uploadId } = await started.json();
    const parts = [];
    for (const [n, chunk] of [data.slice(0, UPLOAD_PART_SIZE), data.slice(UPLOAD_PART_SIZE)].entries()) {
      const res = await publish(`uploads/${key}?uploadId=${uploadId}&part=${n + 1}`, "PUT", chunk);
      expect(res.status).toBe(201);
      parts.push(await res.json());
    }
    const done = await publish(`uploads/${key}?uploadId=${uploadId}`, "POST", JSON.stringify({ parts }));
    expect(await done.json()).toEqual({ key, size: data.byteLength });
    const res = await call(`/${key}`, { headers: { range: `bytes=${UPLOAD_PART_SIZE}-` } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(UPLOAD_PART_SIZE));
  });

  it("names the files it lacks, or has with another size or MD5", async () => {
    await putFile("maps/2026-10-08/a.bin", "aaa");
    await putFile("maps/2026-10-08/b.bin", "bbb");
    const files = [
      { key: "maps/2026-10-08/a.bin", size: 3, md5: md5("aaa") },
      { key: "maps/2026-10-08/b.bin", size: 3, md5: md5("BBB") },
      { key: "maps/2026-10-08/c.bin", size: 3, md5: md5("ccc") },
    ];
    const res = await publish("files-missing", "POST", JSON.stringify({ files }));
    expect(await res.json()).toEqual({ missing: ["maps/2026-10-08/b.bin", "maps/2026-10-08/c.bin"] });
  });
});

describe("maps", () => {
  it("publishes an uploaded release and serves its files, `@` names too", async () => {
    expect((await publish("maps/2026-10-08", "PUT")).status).toBe(409);
    await putFile("maps/2026-10-08/sprite-ofm@2x.png", "png", "image/png");
    await putFile("maps/2026-10-08/index.json", JSON.stringify({ osm_date: "2026-10-01" }));
    expect((await publish("maps/2026-10-08", "PUT")).status).toBe(400);
    await putFile("maps/2026-10-08/index.json", JSON.stringify({ osm_date: "2026-10-08" }));
    expect((await publish("maps/2026-10-08", "PUT")).status).toBe(201);
    expect(await (await call("/maps/latest.json")).json()).toEqual({ osm_date: "2026-10-08", published: expect.any(String) });
    const sprite = await call(`/maps/2026-10-08/${encodeURIComponent("sprite-ofm@2x.png")}`);
    expect(sprite.headers.get("content-type")).toBe("image/png");
    expect(await sprite.text()).toBe("png");
  });
});
