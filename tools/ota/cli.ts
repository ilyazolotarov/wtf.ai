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

/**
 * The app's update config: the URL from UPDATES_ORIGIN, as app.config.js makes it for the app (the repo names no
 * server), the certificate from app.json (the public config, `expo config`, leaves it out).
 */
export function updatesConfig(): { url: string; codeSigningCertificate: string } {
  const updates = (JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")) as { expo: { updates?: { codeSigningCertificate?: string } } }).expo
    .updates;
  if (!updates?.codeSigningCertificate) throw new Error("app.json has no updates.codeSigningCertificate");
  const origin = process.env.UPDATES_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin) throw new Error("UPDATES_ORIGIN is not set: the update Worker's address (repository variable; docs/OTA.md)");
  return { url: `${origin}/manifest`, codeSigningCertificate: updates.codeSigningCertificate };
}

/** The runtime version a build of this checkout has (fingerprint policy, fingerprint.config.js). */
export function resolveRuntimeVersion(platform: Platform): string {
  const out = runCli("expo-updates/bin/cli.js", ["runtimeversion:resolve", "--platform", platform]);
  const line = out.split("\n").find((l) => l.startsWith('{"runtimeVersion"'));
  const runtimeVersion = line ? (JSON.parse(line) as { runtimeVersion: unknown }).runtimeVersion : undefined;
  if (typeof runtimeVersion !== "string") throw new Error(`could not resolve the ${platform} runtime version`);
  return runtimeVersion;
}

/** The update Worker's origin: `--url`, else UPDATES_ORIGIN. */
export const workerOrigin = (): string => flag("url")?.replace(/\/+$/, "") ?? new URL(updatesConfig().url).origin;

/** A request to the Worker's `/publish/…` routes with the publish token. */
export async function publishCall(
  method: string,
  route: string,
  token: string,
  body?: BodyInit,
  contentType = "application/json",
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(`${workerOrigin()}/publish/${route}`, {
    method,
    body,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": contentType } : {}), ...headers },
  });
  if (res.status === 401) throw new Error("the Worker refused OTA_PUBLISH_TOKEN");
  return res;
}

export async function expectOk(res: Promise<Response>, what: string): Promise<Response> {
  const r = await res;
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${await r.text()}`);
  return r;
}

/** After a publish: the Worker removes what it replaced (docs/UPDATES-SPEC.md §2.1). Failing only warns: the cron retries. */
export async function requestPrune(token: string): Promise<void> {
  try {
    const res = await expectOk(publishCall("POST", "prune", token), "pruning");
    const { removed } = (await res.json()) as { removed: string[] };
    console.log(`pruned ${removed.length} objects no phone needs`);
  } catch (e) {
    console.warn(`prune: ${e instanceof Error ? e.message : e} (the daily cron tries again)`);
  }
}

/** Runs `run` over `items`, `parallel` at a time. */
export async function inParallel<T>(items: T[], run: (item: T) => Promise<unknown>, parallel = 8) {
  const queue = [...items];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
  }));
}

export function runMain(main: () => void | Promise<void>) {
  Promise.resolve()
    .then(main)
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
