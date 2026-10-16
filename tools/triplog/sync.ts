// Backs the trip logs up to a private S3-compatible bucket (Cloudflare R2) and fetches them on another PC (tools/triplog/README.md).
//
//   npm run logs:status   what differs, changes nothing
//   npm run logs:push     uploads new and locally changed files
//   npm run logs:pull     downloads new and remotely changed files
//   npm run logs:purge    only deletes from the bucket what a local-only folder (synthetic/) put there
//
// Credentials: .env.local, read by s3.ts. Testers' uploads (logs/testers/<name>/) come down with the rest.
//
// Nothing is deleted on either side but what the replay viewer's Delete listed in .deleted.json (deleted.ts): a push
// deletes those from the bucket, a pull removes a copy another PC still has, and neither brings them back. The
// simulated drives (synthetic/, `npm run sim:drives` makes them again) stay on this PC. A file is overwritten only
// where it is unchanged since the last sync
// (.sync.json in the logs folder remembers each file's MD5 then); edited on both sides, it is reported and left
// alone. Before a remote file is replaced, it is copied to history/<key>.<time>, so an earlier drawing of the
// ground truth can always be brought back. A .ulg never changes after the phone writes it, so a different one
// under the same name is always reported, never replaced.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDeleted } from "./deleted";
import { credentials, enc, encPath, listRemote, md5, s3, type Remote } from "./s3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const STATE_FILE = path.join(LOG_DIR, ".sync.json");
const PREFIX = "logs/";
/** Folders of the logs folder that stay on this PC: regenerated, and gigabytes. */
const LOCAL_ONLY = new Set(["synthetic"]);
const localOnly = (key: string) => LOCAL_ONLY.has(key.split("/")[0]);

/** Every file under the logs folder, by its path with forward slashes; the sync's own state left out. */
function listLocal(dir = LOG_DIR, rel = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel + e.name;
    if (e.isDirectory() && !(rel === "" && LOCAL_ONLY.has(e.name))) for (const [k, v] of listLocal(path.join(dir, e.name), r + "/")) out.set(k, v);
    else if (e.isFile() && r !== ".sync.json") out.set(r, md5(readFileSync(path.join(dir, e.name))));
  }
  return out;
}

type Action = {
  key: string;
  what: "upload" | "replace remote" | "download" | "replace local" | "conflict" | "same" | "record" | "delete remote" | "delete local";
  note?: string;
};

/** Three-way: local, remote, and what both were at the last sync. */
function plan(local: Map<string, string>, remote: Map<string, Remote>, base: Record<string, string>, deleted: Record<string, string>): Action[] {
  const keys = [...new Set([...local.keys(), ...[...remote.keys()].filter((k) => !k.startsWith("history/") && !localOnly(k))])].sort();
  return keys.flatMap((key): Action[] => {
    const l = local.get(key), r = remote.get(key)?.md5, b = base[key];
    // Deleted on purpose: gone from the bucket on push, from this PC on pull, never copied either way.
    if (key in deleted) return [...(r ? [{ key, what: "delete remote" as const }] : []), ...(l ? [{ key, what: "delete local" as const }] : [])];
    return [planOne(key, l, r, b)];
  });
}

function planOne(key: string, l: string | undefined, r: string | undefined, b: string | undefined): Action {
  if (l && !r) return { key, what: "upload" };
  if (!l && r) return { key, what: "download" };
  if (l === r) return { key, what: b === l ? "same" : "record" };
  if (key.endsWith(".ulg")) return { key, what: "conflict", note: "a trip log differs from the backed-up one; logs never change, so look before replacing either" };
  if (b && l === b) return { key, what: "replace local" };
  if (b && r === b) return { key, what: "replace remote" };
  return { key, what: "conflict", note: b ? "changed here and in the bucket since the last sync" : "differs from the bucket, and was never synced from this PC" };
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

async function main() {
  const mode = process.argv[2];
  if (mode !== "status" && mode !== "push" && mode !== "pull" && mode !== "purge") throw new Error("usage: sync.ts status|push|pull|purge");
  const c = credentials();
  const remote = await listRemote(c, PREFIX);
  const local = listLocal();
  const base: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const deleted = readDeleted(LOG_DIR).deleted;
  const actions = plan(local, remote, base, deleted);
  const saveBase = () => writeFileSync(STATE_FILE, JSON.stringify(base, null, 1) + "\n");

  const pushes = actions.filter((a) => a.what === "upload" || a.what === "replace remote");
  const pulls = actions.filter((a) => a.what === "download" || a.what === "replace local");
  const conflicts = actions.filter((a) => a.what === "conflict");
  const deleteRemote = actions.filter((a) => a.what === "delete remote");
  const deleteLocal = actions.filter((a) => a.what === "delete local");
  for (const a of actions) if (a.what === "same" || a.what === "record") base[a.key] = local.get(a.key)!;

  // Local-only folders in the bucket (pushed before they were): reported, deleted on request.
  const strays = [...remote.values()].filter((r) => localOnly(r.key));
  const purge = mode === "purge";
  if (purge) {
    for (const r of strays) {
      await s3(c, "DELETE", PREFIX + r.key);
      delete base[r.key];
    }
    saveBase();
    console.log(`deleted from the bucket  ${strays.length} files of ${[...LOCAL_ONLY].join(", ")}/  ${mb(strays.reduce((n, r) => n + r.size, 0))}`);
  } else if (mode === "push") {
    for (const a of deleteRemote) {
      await s3(c, "DELETE", PREFIX + a.key);
      delete base[a.key];
      saveBase();
      console.log(`deleted from the bucket  ${a.key}  ${mb(remote.get(a.key)!.size)}`);
    }
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
    for (const a of deleteLocal) {
      unlinkSync(path.join(LOG_DIR, a.key));
      delete base[a.key];
      saveBase();
      console.log(`deleted here (deleted on another PC)  ${a.key}`);
    }
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
  } else if (mode === "status") {
    for (const a of pushes) console.log(`to push  ${a.key}${a.what === "replace remote" ? "  (changed here)" : ""}`);
    for (const a of pulls) console.log(`to pull  ${a.key}${a.what === "replace local" ? "  (changed in the bucket)" : ""}`);
    for (const a of deleteRemote) console.log(`to delete from the bucket on push  ${a.key}  ${mb(remote.get(a.key)!.size)}`);
    for (const a of deleteLocal) console.log(`to delete here on pull (deleted on another PC)  ${a.key}`);
  }
  saveBase();
  for (const a of conflicts) console.log(`CONFLICT  ${a.key}: ${a.note}`);

  const backed = [...remote.values()].filter((r) => !r.key.startsWith("history/") && !localOnly(r.key));
  const bytes = backed.reduce((s, r) => s + r.size, 0);
  const localBytes = [...local.keys()].reduce((s, k) => s + statSync(path.join(LOG_DIR, k)).size, 0);
  const left = mode === "push" ? pulls.length : mode === "pull" ? pushes.length : 0;
  console.log(
    `${local.size} files here (${mb(localBytes)}), ${backed.length} in the bucket before this run (${mb(bytes)})` +
      (mode === "status" ? `: ${pushes.length} to push, ${pulls.length} to pull, ${deleteRemote.length} to delete from the bucket` : left ? `; ${left} to ${mode === "push" ? "pull" : "push"}` : "") +
      (conflicts.length ? `, ${conflicts.length} conflicts` : ""),
  );
  if (strays.length && !purge) {
    console.log(
      `${strays.length} files (${mb(strays.reduce((n, r) => n + r.size, 0))}) of ${[...LOCAL_ONLY].join(", ")}/ are in the bucket but stay on each PC: ` +
        "`npm run logs:purge` deletes them from it",
    );
  }
  if (conflicts.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
