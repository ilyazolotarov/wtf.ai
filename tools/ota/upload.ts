// Uploads a native build or a map release to the update Worker (docs/OTA.md, docs/UPDATES-SPEC.md §3–4).
//
//   OTA_PUBLISH_TOKEN=... npm run ota:upload -- --app ios --file wtfai-Release-unsigned.ipa --build 3517000 \
//       --version 1.0.0 --runtime <fingerprint> [--commit <sha>] [--permissions '<json>'] [--min-os 16.4]
//   OTA_PUBLISH_TOKEN=... npm run ota:upload -- --maps tools/tiles/out/release
//
// A file goes in one request up to 64 MiB, else in 32 MiB parts; files the Worker has already (same size and MD5) are
// skipped, so a failed run can simply be repeated. The build's record, or the map release's switch, comes last: until
// then phones see nothing new. Prints what it did; `--url` overrides the Worker (app.json's updates.url).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";

import { expectOk, flag, inParallel, publishCall, requestPrune, runMain, workerOrigin, ROOT } from "./cli";
import { cleanNotes, MAX_NOTES } from "./notes";
import {
  appFileKey,
  isPlatform,
  mapFileKey,
  parseAppBuild,
  SINGLE_UPLOAD_MAX,
  UPLOAD_PART_SIZE,
  type AppBuild,
  type AppPermissions,
  type Platform,
} from "./protocol";

const ATTEMPTS = 4;

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

/** The titles of the commits since `previous` (the last published build's), or of `commit` alone. */
function notesSince(previous: string | undefined, commit: string): string[] {
  if (previous && previous !== commit) {
    try {
      return cleanNotes(git("log", "--no-merges", "--format=%s", `-${MAX_NOTES * 2}`, `${previous}..${commit}`).split("\n"));
    } catch {
      // `previous` isn't in this clone (a shallow checkout, or history rewritten): the commit's own title.
    }
  }
  return cleanNotes([git("log", "-1", "--format=%s", commit)]);
}

async function hashes(file: string): Promise<{ size: number; md5: string; sha256: string }> {
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    md5.update(chunk as Buffer);
    sha256.update(chunk as Buffer);
  }
  return { size: statSync(file).size, md5: md5.digest("hex"), sha256: sha256.digest("hex") };
}

function readPart(file: string, offset: number, length: number): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(length);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) read += readSync(fd, buffer, read, length - read, offset + read);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/** Retries a request a few times: a run uploads hundreds of files over one connection's bad minute. */
async function retried<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= ATTEMPTS || (e instanceof Error && e.message.includes("OTA_PUBLISH_TOKEN"))) throw e;
      console.warn(`${what}: ${e instanceof Error ? e.message : e}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * i));
    }
  }
}

const contentTypeOf = (name: string): string =>
  ({
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".png": "image/png",
    ".pbf": "application/x-protobuf",
    ".ipa": "application/octet-stream",
    ".apk": "application/vnd.android.package-archive",
  })[path.extname(name)] ?? "application/octet-stream";

async function uploadFile(token: string, key: string, file: string, size: number, md5: string): Promise<void> {
  const headers = { "x-file-md5": md5 };
  const type = contentTypeOf(file);
  if (size <= SINGLE_UPLOAD_MAX) {
    await retried(key, () => expectOk(publishCall("PUT", `files/${key}`, token, new Uint8Array(readFileSync(file)), type, headers), `uploading ${key}`));
    return;
  }
  const started = await retried(key, () => expectOk(publishCall("POST", `uploads/${key}`, token, undefined, type, { ...headers, "content-type": type }), `starting ${key}`));
  const { uploadId } = (await started.json()) as { uploadId: string };
  const count = Math.ceil(size / UPLOAD_PART_SIZE);
  const parts: { partNumber: number; etag: string }[] = [];
  await inParallel(
    Array.from({ length: count }, (_, i) => i + 1),
    async (part) => {
      const offset = (part - 1) * UPLOAD_PART_SIZE;
      const body = readPart(file, offset, Math.min(UPLOAD_PART_SIZE, size - offset));
      const route = `uploads/${key}?uploadId=${encodeURIComponent(uploadId)}&part=${part}`;
      const res = await retried(`${key} part ${part}`, () => expectOk(publishCall("PUT", route, token, body, "application/octet-stream"), `${key} part ${part}`));
      parts.push((await res.json()) as { partNumber: number; etag: string });
    },
    4,
  );
  parts.sort((a, b) => a.partNumber - b.partNumber);
  const route = `uploads/${key}?uploadId=${encodeURIComponent(uploadId)}`;
  await retried(key, () => expectOk(publishCall("POST", route, token, JSON.stringify({ parts })), `completing ${key}`));
}

interface Upload {
  key: string;
  file: string;
  size: number;
  md5: string;
}

/** Uploads what the Worker lacks; `last` (if any) after all the others. Returns how many went up. */
async function uploadMissing(token: string, uploads: Upload[], last?: Upload): Promise<number> {
  const all = last ? [...uploads, last] : uploads;
  const res = await expectOk(publishCall("POST", "files-missing", token, JSON.stringify({ files: all.map(({ key, size, md5 }) => ({ key, size, md5 })) })), "listing missing files");
  const missing = new Set(((await res.json()) as { missing: string[] }).missing);
  const todo = uploads.filter((u) => missing.has(u.key));
  // Small files several at a time; the big ones send their own parts in parallel.
  await inParallel(todo, (u) => uploadFile(token, u.key, u.file, u.size, u.md5), 6);
  if (last && missing.has(last.key)) await uploadFile(token, last.key, last.file, last.size, last.md5);
  return todo.length + (last && missing.has(last.key) ? 1 : 0);
}

async function uploadApp(token: string, platform: Platform) {
  const file = flag("file");
  const build = Number(flag("build"));
  const version = flag("version");
  const runtime = flag("runtime");
  const commit = flag("commit") ?? process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  if (!file || !Number.isSafeInteger(build) || build <= 0 || !version || !runtime) {
    throw new Error("--app needs --file, --build, --version and --runtime");
  }
  // How the AltStore source shows the app: from app.json and the repo CI runs in (none of it named in the Worker).
  const expo = (JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")) as {
    expo: { name?: string; icon?: string; ios?: { bundleIdentifier?: string; icon?: string } };
  }).expo;
  const repo = process.env.GITHUB_REPOSITORY;
  const icon = (expo.ios?.icon ?? expo.icon)?.replace(/^\.\//, "");
  const appInfo = {
    ...(expo.name ? { name: expo.name } : {}),
    ...(expo.ios?.bundleIdentifier ? { bundleId: expo.ios.bundleIdentifier } : {}),
    ...(repo ? { website: `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}` } : {}),
    ...(repo && icon ? { iconUrl: `https://raw.githubusercontent.com/${repo}/${commit}/${icon}` } : {}),
  };
  const permissionsJson = flag("permissions");
  const permissions = permissionsJson ? (JSON.parse(permissionsJson) as AppPermissions) : undefined;
  const minOS = flag("min-os");

  const previous = await fetch(`${workerOrigin()}/apps/${platform}/latest.json`);
  const previousCommit = previous.ok ? parseAppBuild(await previous.json())?.commit : undefined;
  const name = `wtfai-${build}.${platform === "ios" ? "ipa" : "apk"}`;
  const { size, md5, sha256 } = await hashes(file);
  const sent = await uploadMissing(token, [{ key: appFileKey(platform, name), file, size, md5 }]);
  const record: Omit<AppBuild, "date"> = {
    platform,
    version,
    build,
    runtime,
    commit,
    file: name,
    size,
    md5,
    sha256,
    notes: notesSince(previousCommit, commit),
    ...(permissions ? { permissions } : {}),
    ...(minOS ? { minOS } : {}),
    ...appInfo,
  };
  const res = await expectOk(publishCall("PUT", `apps/${platform}`, token, JSON.stringify(record)), "publishing the build");
  const { latest } = (await res.json()) as { latest: boolean };
  console.log(`${platform}: build ${build} (${(size / 1e6).toFixed(1)} MB, ${sent ? "uploaded" : "already there"}) published${latest ? ", now the latest" : " (an older build: not the latest)"}`);
  console.log(`${platform}: ${workerOrigin()}/${appFileKey(platform, name)}`);
  for (const note of record.notes) console.log(`  • ${note}`);
}

async function uploadMaps(token: string, dir: string) {
  const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as { osm_date?: string };
  const date = index.osm_date;
  if (!date) throw new Error(`${dir}/index.json has no osm_date`);
  const names = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isFile());
  const uploads: Upload[] = [];
  let indexUpload: Upload | undefined;
  for (const name of names) {
    const file = path.join(dir, name);
    const { size, md5 } = await hashes(file);
    const upload = { key: mapFileKey(date, name), file, size, md5 };
    if (name === "index.json") indexUpload = upload;
    else uploads.push(upload);
  }
  const total = uploads.reduce((n, u) => n + u.size, 0) + (indexUpload?.size ?? 0);
  console.log(`maps ${date}: ${names.length} files, ${(total / 1e9).toFixed(2)} GB`);
  // index.json last: a release whose index is there has all its files.
  const sent = await uploadMissing(token, uploads, indexUpload);
  console.log(`maps ${date}: ${sent} of ${names.length} files uploaded (the rest were there already)`);
  await expectOk(publishCall("PUT", `maps/${date}`, token), "publishing the maps");
  console.log(`maps ${date}: now the current release (${workerOrigin()}/maps/latest.json)`);
}

async function main() {
  const token = process.env.OTA_PUBLISH_TOKEN;
  if (!token) throw new Error("OTA_PUBLISH_TOKEN is not set");
  const app = flag("app");
  const maps = flag("maps");
  if (app) {
    if (!isPlatform(app)) throw new Error("--app ios|android");
    await uploadApp(token, app);
  } else if (maps) {
    await uploadMaps(token, path.resolve(maps));
  } else {
    throw new Error("--app ios|android --file … or --maps <dir>");
  }
  await requestPrune(token);
}

runMain(main);
