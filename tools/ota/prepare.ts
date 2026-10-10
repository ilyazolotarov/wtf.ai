// Turns an `expo export` into signed OTA updates, ready for `npm run ota:publish` (docs/OTA.md).
//
//   npx expo export --platform ios --platform android
//   OTA_SIGNING_KEY="$(cat private-key.pem)" npm run ota:prepare -- [--dist dist] [--out ota-out] [--commit <sha>]
//                                                                    [--runtime-ios <v>] [--runtime-android <v>]
//   OTA_SIGNING_KEY=... npm run ota:prepare -- --rollback --platform ios --runtime-ios <v>
//                       a signed rollBackToEmbedded instead: phones of that runtime go back to their build's own JS
//
// Writes, for the Worker's store:
//   <out>/assets/<key>                                   every file the updates use, named by its SHA-256
//   <out>/updates/<runtimeVersion>/<platform>/<id>.json  {id, manifest | directive, signature}: the exact body served
//                                                        and its expo-signature header
//
// The runtime version is resolved here (fingerprint policy) unless given; the IPA/APK built from the same commit has the
// same one. Run it in CI, not on Windows: line endings change the fingerprint.
import { execFileSync } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { flag, resolveRuntimeVersion, ROOT, runCli, runMain, updatesConfig } from "./cli";
import { buildManifest, rollbackDirective, signatureHeader, type ExportMetadata } from "./manifest";
import { isPlatform, type Platform, type PublishedRecord } from "./protocol";

/** The signature must check out against the certificate the app was built with, or every phone rejects the update. */
function signForApp(body: string, privateKey: string, certificatePem: string): string {
  const header = signatureHeader(body, privateKey);
  const sig = /sig="([^"]+)"/.exec(header)?.[1] ?? "";
  if (!createVerify("RSA-SHA256").update(body, "utf8").verify(createPublicKey(certificatePem), sig, "base64")) {
    throw new Error("OTA_SIGNING_KEY does not match certs/certificate.pem");
  }
  return header;
}

function writeRecord(out: string, runtimeVersion: string, platform: Platform, record: PublishedRecord) {
  const dir = path.join(out, "updates", runtimeVersion, platform);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record));
}

function main() {
  const dist = path.resolve(flag("dist") ?? "dist");
  const out = path.resolve(flag("out") ?? "ota-out");
  const commit = flag("commit") ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const privateKey = process.env.OTA_SIGNING_KEY;
  if (!privateKey) throw new Error("OTA_SIGNING_KEY (the PEM of the update signing key) is not set");

  const updates = updatesConfig();
  const baseUrl = new URL(updates.url).origin;
  const certificate = readFileSync(path.resolve(ROOT, updates.codeSigningCertificate), "utf8");
  const only = flag("platform");
  if (only !== undefined && !isPlatform(only)) throw new Error("--platform is ios or android");

  if (process.argv.includes("--rollback")) {
    if (!only) throw new Error("--rollback needs --platform and --runtime-<platform>");
    const runtimeVersion = flag(`runtime-${only}`);
    if (!runtimeVersion) throw new Error(`--rollback needs --runtime-${only}: the runtime version on the phone's About page`);
    const now = new Date();
    const directive = rollbackDirective(now);
    writeRecord(out, runtimeVersion, only, { id: `rollback-${now.getTime()}`, directive, signature: signForApp(directive, privateKey, certificate) });
    console.log(`${only}: rollback to the embedded JS for runtime ${runtimeVersion}`);
    return;
  }

  // What the app reads as Constants.expoConfig while it runs the update.
  const expoClient = JSON.parse(runCli("expo/bin/cli", ["config", "--json", "--type", "public"])) as Record<string, unknown>;
  const metadata = JSON.parse(readFileSync(path.join(dist, "metadata.json"), "utf8")) as ExportMetadata;
  const createdAt = new Date();
  const platforms = Object.keys(metadata.fileMetadata).filter(isPlatform).filter((p) => !only || p === only);
  if (!platforms.length) throw new Error(`${dist} has no ${only ?? "ios or android"} bundle: run npx expo export first`);

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
    mkdirSync(path.join(out, "assets"), { recursive: true });
    for (const f of files) copyFileSync(path.join(dist, f.path), path.join(out, "assets", f.key));
    writeRecord(out, runtimeVersion, platform, { id: manifest.id, manifest: body, signature: signForApp(body, privateKey, certificate) });
    console.log(`${platform}: update ${manifest.id} for runtime ${runtimeVersion}, ${files.length} files (commit ${commit.slice(0, 7)})`);
  }
}

runMain(main);
