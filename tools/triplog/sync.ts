// Backs the trip logs up to a private S3-compatible bucket (Cloudflare R2) and fetches them on another PC (tools/triplog/README.md).
//
//   npm run logs:status   what differs, changes nothing
//   npm run logs:push     uploads new and locally changed files
//   npm run logs:pull     downloads new and remotely changed files
//
// Credentials: .env.local, read by s3.ts. Testers' uploads (logs/testers/<name>/) come down with the rest.
//
// Nothing is ever deleted, on either side. A file is overwritten only where it is unchanged since the last sync
// (.sync.json in the logs folder remembers each file's MD5 then); edited on both sides, it is reported and left
// alone. Before a remote file is replaced, it is copied to history/<key>.<time>, so an earlier drawing of the
// ground truth can always be brought back. A .ulg never changes after the phone writes it, so a different one
// under the same name is always reported, never replaced.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { credentials, enc, encPath, listRemote, md5, s3, type Remote } from "./s3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const STATE_FILE = path.join(LOG_DIR, ".sync.json");
const PREFIX = "logs/";

/** Every file under the logs folder, by its path with forward slashes; the sync's own state left out. */
function listLocal(dir = LOG_DIR, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel + e.name;
    if (e.isDirectory()) for (const [k, v] of listLocal(path.join(dir, e.name), r + "/")) out.set(k, v);
    else if (e.isFile() && r !== ".sync.json") out.set(r, md5(readFileSync(path.join(dir, e.name))));
  }
  return out;
}

type Action = { key: string; what: "upload" | "replace remote" | "download" | "replace local" | "conflict" | "same" | "record"; note?: string };

/** Three-way: local, remote, and what both were at the last sync. */
function plan(local: Map<string, string>, remote: Map<string, Remote>, base: Record<string, string>): Action[] {
  const keys = [...new Set([...local.keys(), ...[...remote.keys()].filter((k) => !k.startsWith("history/"))])].sort();
  return keys.map((key): Action => {
    const l = local.get(key), r = remote.get(key)?.md5, b = base[key];
    if (l && !r) return { key, what: "upload" };
    if (!l && r) return { key, what: "download" };
    if (l === r) return { key, what: b === l ? "same" : "record" };
    if (key.endsWith(".ulg")) return { key, what: "conflict", note: "a trip log differs from the backed-up one; logs never change, so look before replacing either" };
    if (b && l === b) return { key, what: "replace local" };
    if (b && r === b) return { key, what: "replace remote" };
    return { key, what: "conflict", note: b ? "changed here and in the bucket since the last sync" : "differs from the bucket, and was never synced from this PC" };
  });
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function main() {
  const mode = process.argv[2];
  if (mode !== "status" && mode !== "push" && mode !== "pull") throw new Error("usage: sync.ts status|push|pull");
  const c = credentials();
  const remote = await listRemote(c, PREFIX);
  const local = listLocal();
  const base: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const actions = plan(local, remote, base);
  const saveBase = () => writeFileSync(STATE_FILE, JSON.stringify(base, null, 1) + "\n");

  const pushes = actions.filter((a) => a.what === "upload" || a.what === "replace remote");
  const pulls = actions.filter((a) => a.what === "download" || a.what === "replace local");
  const conflicts = actions.filter((a) => a.what === "conflict");
  for (const a of actions) if (a.what === "same" || a.what === "record") base[a.key] = local.get(a.key)!;

  if (mode === "push") {
    for (const a of pushes) {
      const file = path.join(LOG_DIR, a.key);
      const body = readFileSync(file);
      if (a.what === "replace remote") {
        const old = remote.get(a.key)!;
        const kept = `${PREFIX}history/${a.key}.${old.modified.replace(/[-:]|\.\d{3}/g, "")}`;
        await s3(c, "PUT", kept, { headers: { "x-amz-copy-source": `/${enc(c.bucket)}/${encPath(PREFIX + a.key)}` } });
      }
      await s3(c, "PUT", PREFIX + a.key, { body, headers: { "content-md5": createHash("md5").update(body).digest("base64") } });
      base[a.key] = md5(body);
      saveBase();
      console.log(`${a.what === "upload" ? "uploaded" : "replaced (old one in history/)"}  ${a.key}  ${mb(body.length)}`);
    }
  } else if (mode === "pull") {
    for (const a of pulls) {
      const body = Buffer.from(await (await s3(c, "GET", PREFIX + a.key)).arrayBuffer());
      if (md5(body) !== remote.get(a.key)!.md5) throw new Error(`${a.key}: download corrupted, nothing written`);
      const file = path.join(LOG_DIR, a.key);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      base[a.key] = md5(body);
      saveBase();
      console.log(`${a.what === "download" ? "downloaded" : "updated"}  ${a.key}  ${mb(body.length)}`);
    }
  } else {
    for (const a of pushes) console.log(`to push  ${a.key}${a.what === "replace remote" ? "  (changed here)" : ""}`);
    for (const a of pulls) console.log(`to pull  ${a.key}${a.what === "replace local" ? "  (changed in the bucket)" : ""}`);
  }
  saveBase();
  for (const a of conflicts) console.log(`CONFLICT  ${a.key}: ${a.note}`);

  const backed = [...remote.values()].filter((r) => !r.key.startsWith("history/"));
  const bytes = backed.reduce((s, r) => s + r.size, 0);
  const localBytes = [...local.keys()].reduce((s, k) => s + statSync(path.join(LOG_DIR, k)).size, 0);
  const left = mode === "push" ? pulls.length : mode === "pull" ? pushes.length : 0;
  console.log(
    `${local.size} files here (${mb(localBytes)}), ${backed.length} in the bucket before this run (${mb(bytes)})` +
      (mode === "status" ? `: ${pushes.length} to push, ${pulls.length} to pull` : left ? `; ${left} to ${mode === "push" ? "pull" : "push"}` : "") +
      (conflicts.length ? `, ${conflicts.length} conflicts` : ""),
  );
  if (conflicts.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
