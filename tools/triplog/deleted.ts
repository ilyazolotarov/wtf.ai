// Logs deleted on purpose (junk: a drive that never moved, a test, a broken log), so they stay deleted everywhere:
// the viewer removes the files and lists them here; `logs:push` deletes them from the bucket; `logs:pull` never
// brings them back and removes a copy another PC still has. The list is a file in the logs folder, so it syncs like
// a drawing does. Keys are paths inside the logs folder with forward slashes, as the sync names files.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DELETED_FILE = ".deleted.json";

export interface DeletedList {
  version: 1;
  /** Key → when it was deleted (ISO). */
  deleted: Record<string, string>;
}

export function readDeleted(logDir: string): DeletedList {
  const f = path.join(logDir, DELETED_FILE);
  if (!existsSync(f)) return { version: 1, deleted: {} };
  const list = JSON.parse(readFileSync(f, "utf8")) as DeletedList;
  return { version: 1, deleted: list.deleted ?? {} };
}

/**
 * Deletes a log and everything named after it beside it (its drawing, its emulator screenshots…) and lists them, so
 * the next push deletes them from the bucket too. `file` is the log's path inside the logs folder. Returns the keys.
 */
export function deleteLog(logDir: string, file: string): string[] {
  const dir = path.dirname(file) === "." ? "" : `${path.dirname(file).replace(/\\/g, "/")}/`;
  const base = path.basename(file, ".ulg");
  const keys = readdirSync(path.join(logDir, dir))
    .filter((f) => f === `${base}.ulg` || f.startsWith(`${base}.`))
    .map((f) => dir + f);
  const list = readDeleted(logDir);
  const at = new Date().toISOString();
  for (const key of keys) {
    unlinkSync(path.join(logDir, key));
    list.deleted[key] = at;
  }
  writeFileSync(path.join(logDir, DELETED_FILE), JSON.stringify(list, null, 1));
  return keys;
}
