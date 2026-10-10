// What the OTA CLIs (prepare.ts, publish.ts) share: flags, the app's updates config, the runtime version.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Platform } from "./protocol";

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(import.meta.dirname, "../..");

export function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Runs a package's CLI with this Node (no npx: works the same on Windows). */
export const runCli = (bin: string, args: string[]): string =>
  execFileSync(process.execPath, [require.resolve(bin, { paths: [ROOT] }), ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

/** `expo.updates` of app.json: the public config (`expo config`) leaves the certificate out. */
export function updatesConfig(): { url: string; codeSigningCertificate: string } {
  const updates = (JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")) as { expo: { updates?: { url?: string; codeSigningCertificate?: string } } }).expo
    .updates;
  if (!updates?.url || !updates.codeSigningCertificate) throw new Error("app.json has no updates.url or codeSigningCertificate");
  return { url: updates.url, codeSigningCertificate: updates.codeSigningCertificate };
}

/** The runtime version a build of this checkout has (fingerprint policy, fingerprint.config.js). */
export function resolveRuntimeVersion(platform: Platform): string {
  const out = runCli("expo-updates/bin/cli.js", ["runtimeversion:resolve", "--platform", platform]);
  const line = out.split("\n").find((l) => l.startsWith('{"runtimeVersion"'));
  const runtimeVersion = line ? (JSON.parse(line) as { runtimeVersion: unknown }).runtimeVersion : undefined;
  if (typeof runtimeVersion !== "string") throw new Error(`could not resolve the ${platform} runtime version`);
  return runtimeVersion;
}

export function runMain(main: () => void | Promise<void>) {
  Promise.resolve()
    .then(main)
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
