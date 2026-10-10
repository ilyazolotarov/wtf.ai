// Turns an `expo export` into signed OTA updates, ready to upload (docs/OTA.md).
//
//   npx expo export --platform ios --platform android
//   OTA_SIGNING_KEY="$(cat private-key.pem)" npm run ota:prepare -- [--dist dist] [--out ota-out] [--commit <sha>]
//                                                                    [--runtime-ios <v>] [--runtime-android <v>]
//
// Writes, for the Worker's store:
//   <out>/assets/<key>                                   every file the updates use, named by its SHA-256
//   <out>/updates/<runtimeVersion>/<platform>/<id>.json  {manifest, signature}: the exact manifest body and its header
//
// The runtime version is resolved here (fingerprint policy) unless given; the IPA/APK built from the same commit has the
// same one. Run it in CI, not on Windows: line endings change the fingerprint.
import { execFileSync } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { buildManifest, signatureHeader, type ExportMetadata, type Platform } from "./manifest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Runs a package's CLI with this Node (no npx: works the same on Windows). */
const runCli = (bin: string, args: string[]): string =>
  execFileSync(process.execPath, [require.resolve(bin, { paths: [ROOT] }), ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

function resolveRuntimeVersion(platform: Platform): string {
  const out = runCli("expo-updates/bin/cli.js", ["runtimeversion:resolve", "--platform", platform]);
  const line = out.split("\n").find((l) => l.startsWith('{"runtimeVersion"'));
  const runtimeVersion = line ? (JSON.parse(line) as { runtimeVersion: unknown }).runtimeVersion : undefined;
  if (typeof runtimeVersion !== "string") throw new Error(`could not resolve the ${platform} runtime version`);
  return runtimeVersion;
}

/** The signature must check out against the certificate the app was built with, or every phone rejects the update. */
function assertSignedForApp(body: string, header: string, certificatePem: string) {
  const sig = /sig="([^"]+)"/.exec(header)?.[1] ?? "";
  if (!createVerify("RSA-SHA256").update(body, "utf8").verify(createPublicKey(certificatePem), sig, "base64")) {
    throw new Error("OTA_SIGNING_KEY does not match certs/certificate.pem");
  }
}

function main() {
  const dist = path.resolve(flag("dist") ?? "dist");
  const out = path.resolve(flag("out") ?? "ota-out");
  const commit = flag("commit") ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const privateKey = process.env.OTA_SIGNING_KEY;
  if (!privateKey) throw new Error("OTA_SIGNING_KEY (the PEM of the update signing key) is not set");

  // What the app reads as Constants.expoConfig while it runs the update.
  const expoClient = JSON.parse(runCli("expo/bin/cli", ["config", "--json", "--type", "public"])) as { updates?: { url?: string } };
  // The public config leaves the certificate out.
  const updates = (JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")) as { expo: { updates?: { url?: string; codeSigningCertificate?: string } } }).expo
    .updates;
  if (!updates?.url || !updates.codeSigningCertificate) throw new Error("app.json has no updates.url or codeSigningCertificate");
  const baseUrl = new URL(updates.url).origin;
  const certificate = readFileSync(path.resolve(ROOT, updates.codeSigningCertificate), "utf8");

  const metadata = JSON.parse(readFileSync(path.join(dist, "metadata.json"), "utf8")) as ExportMetadata;
  const createdAt = new Date();
  const platforms = (Object.keys(metadata.fileMetadata) as Platform[]).filter((p) => p === "ios" || p === "android");
  if (!platforms.length) throw new Error(`${dist} has no ios or android bundle: run npx expo export first`);

  for (const platform of platforms) {
    const runtimeVersion = flag(`runtime-${platform}`) ?? resolveRuntimeVersion(platform);
    const { manifest, files } = buildManifest({
      metadata,
      platform,
      runtimeVersion,
      createdAt,
      read: (p) => readFileSync(path.join(dist, p)),
      baseUrl,
      expoClient,
      commit,
    });
    const body = JSON.stringify(manifest);
    const signature = signatureHeader(body, privateKey);
    assertSignedForApp(body, signature, certificate);

    mkdirSync(path.join(out, "assets"), { recursive: true });
    for (const f of files) copyFileSync(path.join(dist, f.path), path.join(out, "assets", f.key));
    const dir = path.join(out, "updates", runtimeVersion, platform);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${manifest.id}.json`), JSON.stringify({ manifest: body, signature }));
    console.log(`${platform}: update ${manifest.id} for runtime ${runtimeVersion}, ${files.length} files (commit ${commit.slice(0, 7)})`);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
