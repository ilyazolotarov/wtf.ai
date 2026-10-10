# OTA: JS updates without reinstalling

A JS-only change on `main` reaches installed Release builds without a new IPA/APK: `expo-updates` in the app, our own
update server (`workers/app-updates`, a Cloudflare Worker over an R2 bucket), no EAS. Native changes still need a new
build from CI ([CI.md](CI.md)).

## How an update travels

1. A push to `main` changes app code but nothing native for a platform (`ci-plan.sh`: `ota=ios android`).
2. `publish-ota.yml` exports the JS (`expo export`, `EXPO_PUBLIC_BUILD_SHA` = the commit), signs one update per
   platform (`npm run ota:prepare`) and uploads it (`npm run ota:publish -- --require-build`): first the files the
   bucket lacks, then the record that makes it live. Telegram gets a message.
3. At launch the app asks `GET /manifest` with its platform and runtime version, without waiting for the answer. A new
   update downloads in the background and runs from the **next cold start**: an update takes two launches.

A native change on `main` builds Release instead (`build-ios.yml`, `build-android.yml`). The build outputs the
fingerprint it embedded, and `ci.yml`'s `register-ota-runtime` job registers it with the Worker
(`PUT /publish/builds/…`); later JS updates go to it. A build started by hand from **Build Unsigned iOS App** is not
registered: start it from **CI** instead.

## Rules

- **Release builds only.** `expo-updates` is off in Debug builds (the dev client loads its JS itself), so `main`
  builds Release; a branch with `[build]` still gives a Debug dev client for Metro.
- **Runtime version = fingerprint** (`runtimeVersion.policy` in `app.json`): a hash of everything native (Expo SDK,
  native modules, config plugins, `patches/`, `app.json`, …; `fingerprint.config.js` leaves out package.json scripts
  and `.gitignore`). An update goes only to builds with exactly its runtime version, so JS can never land on a
  binary without the native code it needs. Resolve it in CI (Linux/macOS), never on Windows: line endings change it.
- **No update for a runtime no build has.** `--require-build` fails the publish when the fingerprint changed without
  a native build (a native input `ci-plan.sh` does not know): the fix is a build, then publish again.
- **Signed.** The app accepts only updates signed with the key of `certs/certificate.pem` (`rsa-v1_5-sha256`, keyid
  `main`). The private key never enters the repo: it lives with the owner and in the `OTA_SIGNING_KEY` secret.
- **Secrets only on main.** `OTA_SIGNING_KEY` and `OTA_PUBLISH_TOKEN` are secrets of the GitHub environment `ota`,
  which only `main` may use, never repository secrets: every branch push runs workflows, and a workflow edited on a
  branch could print a repository secret (disguised, past the log masking) into public logs. Only the jobs that need
  them (`publish-ota`, `register-ota-runtime`) run in the environment.
  The Worker holds no key: a leaked publish token can replace what phones get only with something CI signed.
  A new certificate means a new native build, and phones on the old one take no updates until they install it.
- **Never mid-drive.** `fallbackToCacheTimeout: 0`; the app never calls `reloadAsync()` on its own.
- **Which JS ran is known.** About shows the JS commit and whether it is built in or an update; trip logs carry
  `ver_update` and `ver_runtime` (TRIP-LOGGER-SPEC §6.2); Sentry events the `js_source` tag next to `build_sha`.
- **Files are immutable.** `assets/<key>` is the file's SHA-256; a file is uploaded once and never changed or
  removed while an update uses it (the client checks each download against the hash in the signed manifest).

## Recovery

- A bundle that crashes at launch makes `expo-updates` fall back to the previous update or the embedded JS by itself
  (`ver_update` … `emergency` in the next trip log).
- A bad update that runs: revert the commit on `main`; CI publishes the reverted JS as a new update.
- Faster, or when the embedded JS is the safe one: send the phones of a runtime back to their build's own JS (the
  runtime is in the build job's log, "build of runtime … registered"):

  ```bash
  OTA_SIGNING_KEY="$(cat private-key.pem)" npm run ota:prepare -- --rollback --platform ios --runtime-ios <runtime> --out rb
  OTA_PUBLISH_TOKEN=... npm run ota:publish -- --out rb
  ```

  The next publish for that runtime replaces the rollback.

## One-time setup (owner)

1. `npx wrangler login`, then `npx wrangler r2 bucket create wtf-ai-updates`.
2. A publish token: any long random string. `npx wrangler secret put PUBLISH_TOKEN --config workers/app-updates/wrangler.toml`.
3. `npm run updates-worker:deploy` (serves at `https://wtf-app-updates.<account>.workers.dev`, the `updates.url` of
   `app.json`).
4. The GitHub environment `ota`, usable from `main` only, with the two secrets:

   ```powershell
   '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT "repos/{owner}/{repo}/environments/ota" --input -
   gh api -X POST "repos/{owner}/{repo}/environments/ota/deployment-branch-policies" -f name=main -f type=branch
   Get-Content -Raw private-key.pem | gh secret set OTA_SIGNING_KEY --env ota
   gh secret set OTA_PUBLISH_TOKEN --env ota --body $token
   ```
5. Build Release on `main` once (Actions → CI → Run workflow, iOS Release, Android ci) and install it: from then on,
   JS pushes reach it.

Without the secrets the publish job fails: `main` no longer builds an IPA/APK for JS-only changes. The key's only
copies are the owner's backup and the secret, which cannot be read back: keep the backup.

## Store layout (R2 `wtf-ai-updates`)

- `assets/<key>`: every file of every update (bundle, fonts, images, voice), shared between updates and platforms.
- `updates/<runtime>/<platform>/<id>.json`: `{id, manifest | directive, signature}`. The Worker serves `manifest`
  byte for byte with `signature` as its `expo-signature` header: re-serializing the JSON breaks the signature.
- `latest/<runtime>/<platform>.json`: a copy of the record phones get now.
- `builds/<runtime>/<platform>.json`: `{commit, built}` of the native build that has the runtime.

The update id is a digest of the runtime version, the platform and every file, so the same JS published twice is the
same update and phones download nothing. `Constants.expoConfig` inside an update comes from the manifest
(`extra.expoClient`, the public Expo config at export time). Old updates and files are never deleted for now (R2's
free 10 GB holds hundreds of updates).
