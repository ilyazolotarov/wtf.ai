/**
 * @jest-environment node
 */
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

import { buildManifest, contentTypeOf, signatureHeader, updateId, type BuildManifestArgs, type ExportMetadata } from "../manifest";

const bytes = (s: string) => new TextEncoder().encode(s);

const FILES: Record<string, Uint8Array> = {
  "_expo/static/js/ios/entry-1.hbc": bytes("ios bundle"),
  "_expo/static/js/android/entry-2.hbc": bytes("android bundle"),
  "assets/aaa": bytes("font"),
  "assets/bbb": bytes("voice"),
};

// As written on Windows: backslashes in asset paths.
const METADATA: ExportMetadata = {
  version: 0,
  bundler: "metro",
  fileMetadata: {
    ios: { bundle: "_expo/static/js/ios/entry-1.hbc", assets: [{ path: "assets\\aaa", ext: "ttf" }, { path: "assets\\bbb", ext: "mp3" }] },
    android: { bundle: "_expo/static/js/android/entry-2.hbc", assets: [{ path: "assets/aaa", ext: "ttf" }] },
  },
};

const args = (over: Partial<BuildManifestArgs> = {}): BuildManifestArgs => ({
  metadata: METADATA,
  platform: "ios",
  runtimeVersion: "fp1",
  createdAt: new Date("2026-10-10T12:00:00Z"),
  read: (path) => {
    const file = FILES[path];
    if (!file) throw new Error(`no file ${path}`);
    return file;
  },
  baseUrl: "https://updates.example",
  expoClient: { name: "wtf.ai", version: "1.0.0" },
  commit: "abc1234",
  ...over,
});

const sha256 = (b: Uint8Array, enc: "hex" | "base64url") => createHash("sha256").update(b).digest(enc);

describe("buildManifest", () => {
  it("describes the bundle and every asset by content hash", () => {
    const { manifest } = buildManifest(args());
    const bundle = FILES["_expo/static/js/ios/entry-1.hbc"];
    expect(manifest.launchAsset).toEqual({
      hash: sha256(bundle, "base64url"),
      key: sha256(bundle, "hex"),
      contentType: "application/javascript",
      url: `https://updates.example/assets/${sha256(bundle, "hex")}`,
    });
    expect(manifest.assets.map((a) => [a.contentType, a.fileExtension])).toEqual([
      ["font/ttf", ".ttf"],
      ["audio/mpeg", ".mp3"],
    ]);
    expect(manifest.assets[1].hash).toBe(sha256(FILES["assets/bbb"], "base64url"));
    expect(manifest).toMatchObject({
      createdAt: "2026-10-10T12:00:00.000Z",
      runtimeVersion: "fp1",
      metadata: { commit: "abc1234" },
      extra: { expoClient: { name: "wtf.ai", version: "1.0.0" } },
    });
  });

  it("lists each file to upload once, with forward-slash paths", () => {
    const { files } = buildManifest(
      args({
        metadata: {
          ...METADATA,
          fileMetadata: { ios: { bundle: "_expo/static/js/ios/entry-1.hbc", assets: [{ path: "assets\\aaa", ext: "ttf" }, { path: "assets/aaa", ext: "ttf" }] } },
        },
      }),
    );
    expect(files.map((f) => f.path)).toEqual(["_expo/static/js/ios/entry-1.hbc", "assets/aaa"]);
  });

  it("gives the same JS the same id, and new JS or another platform a new one", () => {
    const first = buildManifest(args()).manifest.id;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(buildManifest(args({ createdAt: new Date("2026-10-11T00:00:00Z") })).manifest.id).toBe(first);
    expect(buildManifest(args({ platform: "android" })).manifest.id).not.toBe(first);
    expect(buildManifest(args({ runtimeVersion: "fp2" })).manifest.id).not.toBe(first);
    const changed = args({ read: (p) => (p.endsWith(".hbc") ? bytes("new bundle") : FILES[p]) });
    expect(buildManifest(changed).manifest.id).not.toBe(first);
  });

  it("does not depend on the asset order", () => {
    expect(updateId("fp", "ios", "launch", ["a", "b"])).toBe(updateId("fp", "ios", "launch", ["b", "a"]));
  });

  it("refuses an export without the platform", () => {
    expect(() => buildManifest(args({ metadata: { ...METADATA, fileMetadata: { android: METADATA.fileMetadata.android } } }))).toThrow(
      "no ios bundle",
    );
  });
});

describe("contentTypeOf", () => {
  it("falls back to bytes for an unknown extension", () => {
    expect(contentTypeOf("PNG")).toBe("image/png");
    expect(contentTypeOf("bin")).toBe("application/octet-stream");
  });
});

describe("signatureHeader", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const body = JSON.stringify(buildManifest(args()).manifest);

  const sigOf = (header: string) => /^sig="([A-Za-z0-9+/=]+)", keyid="main"$/.exec(header)?.[1];
  const verifies = (data: string, sig: string) => createVerify("RSA-SHA256").update(data, "utf8").verify(publicKey, sig, "base64");

  it("signs the exact body with RSA-SHA256 as an Expo SFV dictionary", () => {
    const sig = sigOf(signatureHeader(body, privateKey));
    expect(sig).toBeDefined();
    expect(verifies(body, sig!)).toBe(true);
    expect(verifies(body.replace("abc1234", "abc1235"), sig!)).toBe(false);
  });
});
