// Uploads the Google Play bundle to a Play track with the Play Developer API (docs/CI.md → Store builds). No
// dependencies: a service account's key signs the token itself.
//
//   PLAY_SERVICE_ACCOUNT_JSON='<the key file>' npm run store:play -- --file app-release.aab [--track internal]
//       [--status completed]
//
// One edit: the bundle, the track's release with that version code alone, the commit. `--status` is the release's
// (completed, draft); an app Play still holds as a draft takes draft releases only, so a refused completed release is
// made a draft, to be rolled out in Play Console. The package is app.json's android.package.
import { createSign } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import path from "node:path";

import { flag, ROOT, runMain } from "../ota/cli";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const base64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

async function accessToken(account: ServiceAccount): Promise<string> {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
  });
  if (!res.ok) throw new Error(`the service account was refused: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

class PlayError extends Error {
  constructor(
    what: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${what}: HTTP ${status} ${body}`);
  }
}

/**
 * The bundle as a stream: node:https has no timeout of its own, and Play answers only once it has processed the
 * bundle, which can take minutes (fetch gives up after five).
 */
function uploadBundle(url: string, token: string, file: string): Promise<{ versionCode: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": statSync(file).size },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) resolve(JSON.parse(body) as { versionCode: number });
          else reject(new PlayError("uploading the bundle", res.statusCode ?? 0, body));
        });
      },
    );
    req.on("error", reject);
    createReadStream(file).on("error", reject).pipe(req);
  });
}

runMain(async () => {
  const file = flag("file");
  if (!file) throw new Error("--file <the .aab> is required");
  const track = flag("track") ?? "internal";
  const status = flag("status") ?? "completed";
  const json = process.env.PLAY_SERVICE_ACCOUNT_JSON?.trim();
  if (!json) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not set: the service account's JSON key (docs/CI.md)");
  const account = JSON.parse(json) as ServiceAccount;
  const { expo } = JSON.parse(readFileSync(path.join(ROOT, "app.json"), "utf8")) as { expo: { version: string; android: { package: string } } };
  const pkg = expo.android.package;
  const version = expo.version;

  const token = await accessToken(account);
  const call = async (method: string, route: string, what: string, body?: unknown) => {
    const res = await fetch(`${API}/${pkg}/${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new PlayError(what, res.status, text);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };

  const edit = String((await call("POST", "edits", "opening an edit", {})).id);
  try {
    console.log(`${pkg}: uploading ${path.basename(file)} (${(statSync(file).size / 2 ** 20).toFixed(1)} MiB)`);
    const { versionCode } = await uploadBundle(`${UPLOAD_API}/${pkg}/edits/${edit}/bundles?uploadType=media`, token, file);
    const release = (s: string) => ({ track, releases: [{ name: `${version} (${versionCode})`, versionCodes: [String(versionCode)], status: s }] });
    let released = status;
    try {
      await call("PUT", `edits/${edit}/tracks/${track}`, `the ${track} track`, release(status));
    } catch (e) {
      if (!(e instanceof PlayError && status !== "draft" && /draft app/i.test(e.body))) throw e;
      console.warn(`::warning::Play holds the app as a draft: the ${track} release is a draft, roll it out in Play Console`);
      released = "draft";
      await call("PUT", `edits/${edit}/tracks/${track}`, `the ${track} track`, release("draft"));
    }
    try {
      await call("POST", `edits/${edit}:commit`, "committing the edit");
    } catch (e) {
      // Changes Play wants sent for review by hand: committed, then sent in Play Console (Publishing overview).
      if (!(e instanceof PlayError && /changesNotSentForReview/.test(e.body))) throw e;
      await call("POST", `edits/${edit}:commit?changesNotSentForReview=true`, "committing the edit");
      console.warn("::warning::Committed without sending for review: send the changes in Play Console → Publishing overview");
    }
    console.log(`${pkg}: version code ${versionCode} on the ${track} track (${released})`);
  } catch (e) {
    // An open edit blocks nothing, but leaves the console showing it; it expires by itself if this fails too.
    await call("DELETE", `edits/${edit}`, "deleting the edit").catch(() => undefined);
    throw e;
  }
});
