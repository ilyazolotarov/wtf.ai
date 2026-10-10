// Uploads what `npm run ota:prepare` wrote to the update Worker, and makes it what phones get (docs/OTA.md).
//
//   OTA_PUBLISH_TOKEN=... npm run ota:publish -- [--out ota-out] [--require-build] [--url <worker, default: app.json>]
//   OTA_PUBLISH_TOKEN=... npm run ota:publish -- --register-build --platform ios [--runtime <v>] [--commit <sha>]
//
// Files go first (only those the bucket lacks), then each update record; the Worker refuses an update whose files
// are not all there. --require-build stops before anything is published when a runtime has no native build: its
// update would reach no phone, which means the fingerprint changed without a build (a native change CI missed).
// --register-build is run by the build jobs after a Release build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expectOk, flag, inParallel, publishCall as call, requestPrune, resolveRuntimeVersion, runMain } from "./cli";
import type { UpdateManifest } from "./manifest";
import { isPlatform, isRollback, parseRecord, type Platform, type PublishedRecord } from "./protocol";

interface Found {
  runtime: string;
  platform: Platform;
  record: PublishedRecord;
}

function findRecords(out: string): Found[] {
  const dir = path.join(out, "updates");
  if (!existsSync(dir)) throw new Error(`${dir} is missing: run npm run ota:prepare first`);
  const found: Found[] = [];
  for (const runtime of readdirSync(dir)) {
    for (const platform of readdirSync(path.join(dir, runtime)).filter(isPlatform)) {
      for (const file of readdirSync(path.join(dir, runtime, platform))) {
        const record = parseRecord(JSON.parse(readFileSync(path.join(dir, runtime, platform, file), "utf8")));
        if (!record) throw new Error(`${file} is not an update record`);
        found.push({ runtime, platform, record });
      }
    }
  }
  return found;
}

async function main() {
  const token = process.env.OTA_PUBLISH_TOKEN;
  if (!token) throw new Error("OTA_PUBLISH_TOKEN is not set");

  if (process.argv.includes("--register-build")) {
    const platform = flag("platform");
    if (!isPlatform(platform)) throw new Error("--register-build needs --platform ios|android");
    const runtime = flag("runtime") ?? resolveRuntimeVersion(platform);
    const commit = flag("commit") ?? process.env.GITHUB_SHA ?? "unknown";
    await expectOk(call("PUT", `builds/${runtime}/${platform}`, token, JSON.stringify({ commit })), "registering the build");
    console.log(`${platform}: build of runtime ${runtime} registered (commit ${commit.slice(0, 7)})`);
    return;
  }

  const out = path.resolve(flag("out") ?? "ota-out");
  const records = findRecords(out);
  if (!records.length) throw new Error(`no update records in ${out}`);
  // One record per runtime and platform: with two, which one ends up live would depend on the file order.
  const targets = records.map((r) => `${r.runtime}/${r.platform}`);
  const twice = targets.find((t, i) => targets.indexOf(t) !== i);
  if (twice) throw new Error(`${out} has two records for ${twice}: prepare into an empty --out`);

  if (process.argv.includes("--require-build")) {
    for (const { runtime, platform } of records) {
      const res = await call("GET", `builds/${runtime}/${platform}`, token);
      if (res.status === 404) {
        throw new Error(
          `${platform}: no build has runtime ${runtime}, so this update would reach no phone. The fingerprint changed ` +
            "without a native build: build the app (Actions → CI → Run workflow) and publish again.",
        );
      }
      if (!res.ok) throw new Error(`checking the ${platform} build: HTTP ${res.status}`);
    }
  }

  // The content type of each file comes from the manifests that use it.
  const types = new Map<string, string>();
  for (const { record } of records) {
    if (isRollback(record)) continue;
    const m = JSON.parse(record.manifest) as UpdateManifest;
    for (const a of [m.launchAsset, ...m.assets]) types.set(a.key, a.contentType);
  }
  const res = await call("POST", "missing", token, JSON.stringify({ keys: [...types.keys()] }));
  if (!res.ok) throw new Error(`listing missing files: HTTP ${res.status}`);
  const { missing } = (await res.json()) as { missing: string[] };
  await inParallel(missing, (key) =>
    expectOk(call("PUT", `assets/${key}`, token, readFileSync(path.join(out, "assets", key)), types.get(key)), `uploading ${key}`),
  );
  console.log(`${missing.length} of ${types.size} files uploaded (the rest were there already)`);

  for (const { runtime, platform, record } of records) {
    await expectOk(call("PUT", `updates/${runtime}/${platform}/${record.id}`, token, JSON.stringify(record)), `publishing ${record.id}`);
    console.log(`${platform}: ${isRollback(record) ? "rollback" : `update ${record.id}`} is now live for runtime ${runtime}`);
  }
  await requestPrune(token);
}

runMain(main);
