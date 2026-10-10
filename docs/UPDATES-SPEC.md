# wtf.ai — Updates: app and maps

Status: v1 (2026-10-10). How a phone learns of a newer app or map and gets it. The server side of JS updates is
[OTA.md](OTA.md); the bucket layout and the Worker's routes are there too.

## 1. What updates, and how

| What                  | Made by                                         | Reaches the phone                                                                 |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| JS (OTA update)       | `publish-ota.yml`, a JS-only push to `main`     | `expo-updates` downloads it by itself; it runs from the next start, or "Restart"  |
| Native build          | `ci.yml` → `publish-builds`, a native push to `main` | iOS: AltStore, from our AltStore source. Android: the app downloads and opens the APK |
| Offline maps          | `map-packs.yml`, weekly                         | the app downloads the active region again (§5.2)                                  |

Everything is served by one Cloudflare Worker over one R2 bucket (`workers/app-updates`, [OTA.md](OTA.md)), at
its own domain (Workers Paid). The repo is public and names no server: builds and CI take the address from the
repository variable `UPDATES_ORIGIN` (app.config.js, the workflows; README → Configuration). A build without it takes no
updates and checks nothing. Phones contact nothing else for updates.

## 2. Server

- **One bucket, free tier.** R2's free tier is 10 GB of storage; downloads cost nothing. A map release is ~3.6 GB, a
  build ~0.1 GB, a JS update a few MB of new files. The Worker prunes what no phone needs (§2.1), which keeps the
  bucket at ~5 GB: one map release (two for two days after a new one), three builds per platform, the JS of three
  runtimes per platform.
- **Uploads go through the Worker**, with the publish token (`OTA_PUBLISH_TOKEN`); no R2 credentials outside it. A
  file over 64 MiB is uploaded in 32 MiB parts (R2 multipart): the Worker takes at most 100 MB per request.
- **Downloads** of builds and maps answer `Range` (and `If-Range`), so iOS background downloads resume.

### 2.1 Pruning

Run by the Worker's daily cron and by the CLIs after each publish (`POST /publish/prune`), each time as a request of
its own, so a failed prune never fails a publish. It never removes what `latest` points at.

- **Builds**: per platform, the newest 3 (by build number); their files go with them. Files in `apps/` that no kept
  build names are removed a day after upload (a publish that failed halfway).
- **JS updates**: the runtimes kept are the newest 3 per platform, by their build's registration or their latest
  publish, whichever is newer. For each, only the latest record. A runtime not kept loses its records: its phones get "no update" and keep the
  JS they have. A file (`assets/`) that no kept record uses is removed a day after upload, so a publish in progress
  never loses its files.
- **Maps**: the release `maps/latest.json` names, and the one before it for 2 days after the switch (downloads in
  progress finish). Older releases are removed.

## 3. Native builds

- **Build number** (`CFBundleVersion`, `versionCode`): the commit's time in minutes since 2020-01-01 UTC, set by the
  build workflows after prebuild. It grows along `main`, and stays out of `app.json` so it never changes the runtime
  version (fingerprint). `version` (`1.0.0`) changes by hand.
- **Published** by `ci.yml`'s `publish-builds` job for `main`'s Release builds: the IPA/APK under `apps/<platform>/`,
  then its record (`AppBuild`: version, build, runtime, commit, date, file, size, MD5, SHA-256, notes = the commit
  titles since the previous build, at most 20; iOS: the app's permissions). The job also registers the runtime for
  JS updates. Branch builds and Debug builds are never published.
- **A native update is available** when the newest build has a higher build number **and** another runtime than the
  app's. A newer build with the same runtime brings nothing JS updates don't. Only Release builds check
  (`expo-updates` enabled).
- **Android**: the app downloads the APK into its cache, checks size and MD5, and opens the system installer
  (`ACTION_VIEW`, content URI, `REQUEST_INSTALL_PACKAGES`). The first time, Android asks to allow installing apps
  from wtf.ai. The APK is deleted at the next start.
- **iOS**: AltStore Classic installs from **sources**: a JSON list of apps and their IPA links that it polls, showing
  "update available" when the first version listed differs from the installed one (`version` + `buildVersion`). The
  Worker serves ours at `/altstore.json`, built from the kept iOS builds, newest first. "Update" in the app opens it in
  AltStore (`altstore-classic://source?url=…`, AltStore 2.2+; else `altstore://source?url=…`), where the update is
  one tap. AltStore installs through AltServer: a PC on the same Wi-Fi, or (AltStore 2.3+) Remote AltServer from
  anywhere. Without AltStore, "Share IPA" downloads the IPA and opens the share sheet.
  - AltStore refuses an IPA whose entitlements and `…UsageDescription` texts differ from the source's
    `appPermissions`, so CI reads them from the IPA it built (`codesign`, `Info.plist`).
- **Telegram** gets a message per build, never the file: on `main`, `publish-builds` sends the download links (APK,
  AltStore source); a branch build (`[build]`) sends the link to its run, whose artifacts hold the files.

## 4. Maps

- `map-packs.yml` uploads `tools/tiles/out/release/` to `maps/<osm_date>/` (`index.json` last), then publishes it:
  `maps/latest.json` names it. A forced rebuild of the same date uploads over it; the app's MD5 check catches a
  download that mixed the two.
- The app reads `maps/latest.json`, then `maps/<osm_date>/index.json`, and downloads from that directory. While the
  Worker has no maps it falls back to the newest GitHub release `maps-*`, which `map-packs.yml` still publishes for
  builds whose JS predates the Worker.
- A Developer catalog URL (`tiles serve` on a PC) replaces both, as before.

## 5. In the app

`src/services/app-update/`: the checks, the decisions (pure, `decide.ts`, tested), the prompts and the dots.

### 5.1 When it checks

- **At launch**, a few seconds after the map shows, on any network: the newest build (`apps/<platform>/latest.json`,
  under 1 kB). `expo-updates` checks for JS itself at launch (`ON_LOAD`).
- **On return to the foreground**, only on an **unmetered** network (Wi-Fi or Ethernet that the OS doesn't call
  expensive: a phone's hotspot is Wi-Fi but metered), at most every 30 minutes: the newest build and JS
  (`checkForUpdateAsync` → `fetchUpdateAsync`).
- **The map catalog** (`index.json`, ~300 kB) with either, at most every 6 hours across restarts; in between, the
  last check's answer for the active region stands (kept in kv-store), so the dots survive a restart.
- Nothing is checked while the app is in the background. A failed check is silent and retried at the next one.

### 5.2 What it does with what it finds

- **JS update downloaded** (`isUpdatePending`): prompt "Restart" (§5.3). Otherwise it runs from the next start.
- **Native update**: prompt.
- **The active region's map is outdated** (tiles, graph, search index or shared files differ from the catalog):
  - on an unmetered network and the download is at most **300 MB**: download it in the background, no prompt. It is
    installed once no trip records and no route is active; until then it waits, verified, and the old map stays in use.
  - on an unmetered network and bigger (Ukraine, ~1.7 GB): prompt. "Download" starts the same download, installed
    the same way.
  - on a metered network: only the dots.
  An automatic download pauses when the phone leaves for a metered network and goes on back on an unmetered one.
  Cancelling it in Offline maps skips that OSM date (as "Skip" does).
  Other downloaded regions aren't checked: Offline maps shows their update when opened.
- A map release in a newer catalog `format` than the app reads: "Update the app to get newer maps" in Offline maps;
  no prompt, no dot.

### 5.3 Prompts

A system alert, one per check, the most important first: native update, then JS update, then map.

| Prompt      | Text                                                       | Buttons                                   |
| ----------- | ---------------------------------------------------------- | ----------------------------------------- |
| Native, Android | "App update" · version, build, size                    | Later · **Update** (opens App update and starts the download) |
| Native, iOS | "App update" · version, build; "AltStore installs it"      | Later · **Open AltStore**                 |
| JS          | "App update ready" · "Restart the app to use it."          | Later · **Restart** (`reloadAsync`)       |
| Map         | "Map update: {region}" · size, OSM date                    | Skip · Later · **Download**               |

- **Only when nothing is going on**: the map on screen (no page, onboarding, map setup or tour over it, no pin or
  placing card), no trip recording, no route, no adapter connected, not moving (speed under 2 m/s or none). Otherwise
  the dots only, and the prompt waits for a later check. Each prompt shows at most once per launch.
- **Later**: no prompt for that version for 3 days; the dots stay. **Skip** (maps): no prompt and no dot for that OSM
  date; Offline maps still offers it.
- The app never restarts, installs or opens AltStore by itself.

### 5.4 Dots

A red dot (the connection dot's size, `palette.bad`) on **More** in the bottom bar when an app update (native, or JS
downloaded) or a map update (not skipped) is waiting. Inside More, on the row it belongs to: **App update** (a row of
its own, under Offline maps) and **Offline maps**. Each goes when its update is installed.

### 5.5 App update page (`more/update`)

- This app: version, build number, the JS commit and whether it came with the build or as an update.
- Status: "Up to date", "Checking…", or the update: version, build, date, size and the notes (commit titles).
- Actions:
  - JS update downloaded: **Restart to update**.
  - Android native: **Download and install** (progress, cancel), then **Install** (opens the installer again).
  - iOS native: **Open AltStore**, **Share IPA**; the first time: "Add the wtf.ai source in AltStore once; it then
    shows every update."
  - **Check now** (any network).
- A Debug build says updates are off (Metro or its embedded JS).

## 6. Verification

1. Jest: `decide.ts` (every row of §5.2–5.4), the Worker (uploads, multipart, ranges, pruning, the AltStore source),
   the upload CLI's notes.
2. After the first publish: `/altstore.json` passes AltStore (add the source, install, update to the next build);
   an Android phone installs the next APK over the previous one from the app; a map release on the Worker downloads
   and resumes after the app is killed.
3. The bucket stays under 10 GB over a month of weekly maps (Cloudflare dashboard → R2 → metrics).
