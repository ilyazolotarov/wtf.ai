// Native builds for the in-app update and the AltStore source (docs/UPDATES-SPEC.md §3).
import {
  appBuildKey,
  appFileKey,
  appLatestKey,
  parseAppBuild,
  type AppBuild,
  type Platform,
} from "../../tools/ota/protocol";

import { json, listAll, readJson, type Env } from "./bucket";

const BUILD_RECORD_RE = /^apps\/(ios|android)\/(\d+)\.json$/;

/** The published builds of a platform, newest first. */
export async function appBuilds(env: Env, platform: Platform): Promise<AppBuild[]> {
  const keys = (await listAll(env.BUCKET, `apps/${platform}/`)).map((o) => o.key).filter((k) => BUILD_RECORD_RE.test(k));
  const builds: AppBuild[] = [];
  for (const key of keys) {
    const build = parseAppBuild(await readJson(env.BUCKET, key));
    if (build) builds.push(build);
  }
  return builds.sort((a, b) => b.build - a.build);
}

/** PUT `/publish/apps/<platform>`: the record of a build whose file is uploaded already. */
export async function publishApp(request: Request, env: Env, platform: Platform): Promise<Response> {
  const build = parseAppBuild({ ...((await request.json()) as object), date: new Date().toISOString() });
  if (!build || build.platform !== platform) return json(400, { error: "not a build record for this platform" });
  if (!build.file.endsWith(platform === "ios" ? ".ipa" : ".apk")) return json(400, { error: "wrong file type for the platform" });
  const file = await env.BUCKET.head(appFileKey(platform, build.file));
  if (!file || file.size !== build.size || (file.customMetadata?.md5 && file.customMetadata.md5 !== build.md5)) {
    return json(409, { error: `${build.file} is not uploaded, or differs from the record` });
  }
  const text = JSON.stringify(build);
  await env.BUCKET.put(appBuildKey(platform, build.build), text, { httpMetadata: { contentType: "application/json" } });
  const latest = parseAppBuild(await readJson(env.BUCKET, appLatestKey(platform)));
  const isLatest = !latest || build.build >= latest.build;
  if (isLatest) await env.BUCKET.put(appLatestKey(platform), text, { httpMetadata: { contentType: "application/json" } });
  return json(201, { build: build.build, latest: isLatest });
}

/**
 * The AltStore Classic source (https://faq.altstore.io/developers/make-a-source): the kept iOS builds, newest first.
 * AltStore offers the first one as an update whenever its version or build differs from the installed app's. The app's
 * name, bundle id, page and icon come from the newest build's record (CI fills them from app.json and its repo).
 */
export function altStoreSource(builds: AppBuild[], origin: string) {
  const versions = builds.map((b) => ({
    version: b.version,
    buildVersion: String(b.build),
    date: b.date,
    localizedDescription: b.notes.length ? b.notes.map((n) => `• ${n}`).join("\n") : `Build ${b.build}`,
    downloadURL: `${origin}/${appFileKey("ios", b.file)}`,
    size: b.size,
    ...(b.minOS ? { minOSVersion: b.minOS } : {}),
  }));
  const newest = builds[0];
  const name = newest?.name ?? "wtf.ai";
  const bundleId = newest?.bundleId ?? "";
  const links = newest?.website ? { website: newest.website } : {};
  const icon = newest?.iconUrl ? { iconURL: newest.iconUrl } : {};
  const app = {
    name,
    bundleIdentifier: bundleId,
    developerName: name,
    subtitle: "Car navigation that keeps working when GPS is jammed or spoofed.",
    localizedDescription:
      `${name} shows where the car is when GPS is jammed or spoofed: it drives on the car's own speed (an OBD adapter) ` +
      "and the phone's motion sensors, and matches the result to the offline map." +
      (newest?.website ? ` Source and docs: ${newest.website}` : ""),
    ...icon,
    tintColor: "#4371B7",
    category: "utilities",
    versions,
    appPermissions: newest?.permissions ?? { entitlements: [], privacy: {} },
    // The fields of sources before AltStore 2.0, for older AltStore installs.
    ...(newest
      ? { version: newest.version, versionDate: newest.date, downloadURL: versions[0].downloadURL, size: newest.size }
      : {}),
  };
  return {
    name,
    identifier: `${bundleId || "app"}.source`,
    subtitle: `Builds of ${name} from its main branch.`,
    ...links,
    ...icon,
    tintColor: "#4371B7",
    apps: [app],
    news: [],
  };
}

export async function serveAltStoreSource(request: Request, env: Env): Promise<Response> {
  const builds = await appBuilds(env, "ios");
  // The app's name, icon and versions come from its builds: without one AltStore would refuse the source as invalid.
  if (!builds.length) return json(404, { error: "no iOS build published yet" });
  const source = altStoreSource(builds, new URL(request.url).origin);
  return json(200, source, { "cache-control": "public, max-age=300" });
}

export async function serveLatestApp(env: Env, platform: Platform): Promise<Response> {
  const stored = await env.BUCKET.get(appLatestKey(platform));
  if (!stored) return json(404, { error: "no build published" });
  return new Response(stored.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" } });
}
