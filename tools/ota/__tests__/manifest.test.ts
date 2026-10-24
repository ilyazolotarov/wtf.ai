/**
 * @jest-environment node
 */
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";

import { buildManifest, contentTypeOf, signatureHeader, updateId, type BuildManifestArgs, type ExportMetadata } from "../manifest";

const bytes = (s: string) => new TextEncoder().encode(s);
const sha256 = (b: Uint8Array, enc: "hex" | "base64url") => createHash("sha256").update(b).digest(enc);
/** Metro names an exported asset file by its MD5. */
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

const FONT = bytes("font");
const VOICE = bytes("voice");
const FILES: Record<string, Uint8Array> = {
  "_expo/static/js/ios/entry-1.hbc": bytes("ios bundle"),
  "_expo/static/js/android/entry-2.hbc": bytes("android bundle"),
  [`assets/${md5(FONT)}`]: FONT,
  [`assets/${md5(VOICE)}`]: VOICE,
};

// As written on Windows: backslashes in asset paths.
const METADATA: ExportMetadata = {
  version: 0,
  bundler: "metro",
  fileMetadata: {
    ios: { bundle: "_expo/static/js/ios/entry-1.hbc", assets: [{ path: `assets\\${md5(FONT)}`, ext: "ttf" }, { path: `assets\\${md5(VOICE)}`, ext: "mp3" }] },
    android: { bundle: "_expo/static/js/android/entry-2.hbc", assets: [{ path: `assets/${md5(FONT)}`, ext: "ttf" }] },
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

describe("buildManifest", () => {
  it("stores the bundle and every asset by content hash, in their urls", () => {
    const { manifest } = buildManifest(args());
    const bundle = FILES["_expo/static/js/ios/entry-1.hbc"];
    expect(manifest.launchAsset).toEqual({
      hash: sha256(bundle, "base64url"),
      key: sha256(bundle, "hex"),
      contentType: "application/javascript",
      url: `https://updates.example/assets/${sha256(bundle, "hex")}`,
    });
    expect(manifest.assets.map((a) => [a.contentType, a.fileExtension, a.url])).toEqual([
      ["font/ttf", ".ttf", `https://updates.example/assets/${sha256(FONT, "hex")}`],
      ["audio/mpeg", ".mp3", `https://updates.example/assets/${sha256(VOICE, "hex")}`],
    ]);
    expect(manifest.assets[1].hash).toBe(sha256(VOICE, "base64url"));
    expect(manifest).toMatchObject({
      createdAt: "2026-10-10T12:00:00.000Z",
      runtimeVersion: "fp1",
      metadata: { commit: "abc1234" },
      extra: { expoClient: { name: "wtf.ai", version: "1.0.0" } },
    });
  });

  it("keys each asset by Metro's hash, the name the phone finds a require() by", () => {
    // expo-asset resolves a bundled file through Updates.localAssets[<Metro's MD5>]; the phone files a downloaded asset
    // under its manifest key. Keyed by anything else, a file added since the native build never shows.
    const { manifest } = buildManifest(args());
    expect(manifest.assets.map((a) => a.key)).toEqual([md5(FONT), md5(VOICE)]);
    expect(manifest.assets[0].key).not.toBe(sha256(FONT, "hex"));
  });

  it("refuses an asset the export did not name by Metro's hash", () => {
    const metadata: ExportMetadata = { ...METADATA, fileMetadata: { ios: { bundle: "_expo/static/js/ios/entry-1.hbc", assets: [{ path: "assets/font.ttf", ext: "ttf" }] } } };
    expect(() => buildManifest(args({ metadata, read: (p) => (p === "assets/font.ttf" ? FONT : FILES[p]) }))).toThrow("not named by Metro's hash");
  });

  it("carries the commit's title when it has one", () => {
    expect(buildManifest(args({ message: "Faster start" })).manifest.metadata).toEqual({ commit: "abc1234", message: "Faster start" });
  });

  it("lists each file to upload once, with forward-slash paths", () => {
    const { files } = buildManifest(
      args({
        metadata: {
          ...METADATA,
          fileMetadata: { ios: { bundle: "_expo/static/js/ios/entry-1.hbc", assets: [{ path: `assets\\${md5(FONT)}`, ext: "ttf" }, { path: `assets/${md5(FONT)}`, ext: "ttf" }] } },
        },
      }),
    );
    expect(files.map((f) => [f.path, f.key])).toEqual([
      ["_expo/static/js/ios/entry-1.hbc", sha256(FILES["_expo/static/js/ios/entry-1.hbc"], "hex")],
      [`assets/${md5(FONT)}`, sha256(FONT, "hex")],
    ]);
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
