# CI: what runs when

Work happens on many branches at once (people and agents), so CI runs only what a change needs. Most of
the cost is the macOS iOS build. That build is also the only Xcode we have, so native changes are always
compiled.

`.github/workflows/ci.yml` starts with a `plan` job (`.github/scripts/ci-plan.sh`). It looks at the files
changed since the **last commit this branch passed CI on** (if there is none: since the branch left
`main`) and the commit messages in that range. A run cancelled by a newer push, or a failed run, is
covered again by the next run.

## Jobs

| Job                                   | Runs when these changed                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `checks` (lint, tsc, Jest)            | anything except docs (`docs/`, `*.md`, `.claude/`, …), or a build runs      |
| `doctor` (expo-doctor)                | as `checks`; nothing waits for it: it compares the dependencies with Expo's newest patch releases online, so the same commit fails the day one is published. Red here means `npx expo install --fix`, a step of its own (a native change) |
| `python` (pytest)                     | `tools/triplog/`, `tools/tiles/`                                            |
| `native-logic` (Swift tests)          | `modules/*/ios/`, `native-tests/`, `Package.swift`                          |
| `native-logic-android` (Kotlin tests) | `modules/*/android/`, `native-tests-android/`                               |
| `build-ios` (unsigned IPA)            | see below                                                                   |
| `build-android` (signed APK)          | see Android below                                                           |
| `publish-ota` (JS update)             | `main` only, see below and [OTA.md](OTA.md)                                 |
| `publish-builds` (to the update Worker) | `main`'s Release builds: their runtime for OTA, the IPA/APK for the in-app update ([UPDATES-SPEC.md](UPDATES-SPEC.md) §3) |

## Builds

"Native" here: `modules/*/ios/` (iOS) or `modules/*/android/` (Android), and for both
`app.json`, `package.json`, `package-lock.json`, `patches/`, `plugins/`, `metro.config.js`, module
`app.plugin.js` / `expo-module.config.json`, `fingerprint.config.js`, `.fingerprintignore`, `certs/` and the
platform's build workflow.

That list is only a guess. On a push the plan resolves the runtime version ([OTA.md](OTA.md)) of the base and of HEAD
per platform, and a platform is native when its runtime version changed, or `certs/` or its build workflow changed (the
fingerprint hashes neither). On `main` it does this for any app change, so a new package.json script goes out as an
update while a new app icon builds. On a branch it does this only for a native guess, and can only drop a needless
compile check. It costs the plan two `npm ci`. If a runtime version cannot be resolved, the guess stands.

| Event                                  | Build                                    | Telegram | Kept    |
| -------------------------------------- | ---------------------------------------- | -------- | ------- |
| Push to a branch, native change        | Debug, as a compile check                | no       | 7 days  |
| Push to a branch, `[build]` in a commit message | Debug                           | yes (a message: the run's link) | 7 days  |
| Push to a branch, anything else        | none                                     | —        | —       |
| Push to `main`, native change          | Release, published to the update Worker (`publish-builds`: its runtime for OTA, the IPA/APK for the in-app update, [UPDATES-SPEC.md](UPDATES-SPEC.md) §3) | yes (a message: download links) | 14 days |
| Push to `main`, other app code (`src/`, `assets/`, `locales/`, …) | none: an OTA JS update | yes (a message) | — |
| Push to `main`, docs/tools only        | none                                     | —        | —       |
| Pull request from a fork               | native change → Debug compile check      | no       | 7 days  |
| Manual: Actions → **CI** → Run workflow | iOS: Debug / Release / none; all checks | yes      | 14 days |
| Manual: Actions → **Build Unsigned iOS App** | the chosen configuration, no checks | optional | 14 days |

Keywords, in any commit message of a push: `[build]` (both platforms), `[build ios]`, `[build android]`.
GitHub's own `[skip ci]` skips the run entirely. The build keywords act on branches only: `main` ignores them, its
app changes ship by themselves (a native change as a Release build, JS as an OTA update to the builds installed), so
a commit for `main` never needs `[build]`.

`main` builds Release: what phones run, and what takes the OTA updates. Per platform: a platform with a native change
gets a build, the other gets the JS as an update (an iOS-only Swift change builds iOS and updates Android).

Pull requests from branches of this repo don't run CI again: their branch pushes already did.

## Caches (iOS build; Android: see below)

- npm (`setup-node`).
- CocoaPods download cache (`~/Library/Caches/CocoaPods`: pod sources, prebuilt React Native and
  Hermes tarballs), keyed on `package-lock.json`, `patches/` and module podspecs.
- ccache (`~/ccache`, set in React Native's `ccache.conf`) for the C/C++/Objective-C of the pods (`USE_CCACHE=1`, read by the Expo Podfile). React Native
  core and Expo modules come precompiled; Swift is not cached. The build log prints the hit rate
  (`ccache statistics`).

Caches are **saved only by `main`** and restored everywhere: branches start from `main`'s caches and
their builds don't evict them (the repo has 10 GB of cache).

## Android

Android (docs/ANDROID-SPEC.md) uses the same plan: `ci-plan.sh` outputs `build_android` (`ci` on `main`, and for
Android-native changes or `[build android]` on branches; empty otherwise), and the `build-android` job of `ci.yml`
runs `.github/workflows/build-android.yml` with it.

- One build for everyone: a signed release APK with arm64 and armeabi-v7a (32-bit phones). The `ci` / `tester`
  variant only names the file. The simulated adapters are hidden unless switched on (Developer → Show
  emulated adapters, or `wtfai://vehicle?emulators=1`, which the smoke test uses).
- Emulators: Actions → **Build Android APK (emulator)** → Run workflow builds an x86_64-only APK
  (`wtfai-emulator.apk`, an artifact; Telegram if ticked). CI never builds x86_64.
- No emulator test in CI: it took too long. The smoke test (`scripts/android-smoke.sh`) runs against a local
  emulator: `bash scripts/android-smoke.sh path/to/app.apk out-dir`.
- Delivery: like iOS. The APK is uploaded unzipped; Telegram gets a message (never the file) only when the plan says
  `notify`: on `main` from `publish-builds`, with the download link.
- Manual: Actions → **CI** → Run workflow has an `android` choice (`none` / `tester` / `ci`); **Build Android APK**
  can also be started on its own.
- Signed with the stable key on `main` (the `ANDROID_KEYSTORE_*` secrets of the `android-release` environment), else the debug key
  (docs/ANDROID-SPEC.md §4).
- Caches, saved by `main` (a branch reads only its own and `main`'s caches):
  - Gradle (`setup-gradle`): dependencies, wrapper and the Gradle build cache (`--build-cache`: Kotlin/Java
    compiles, dexing).
  - ccache (`~/.ccache`) for the C/C++ of React Native's CMake builds, through `CMAKE_C(XX)_COMPILER_LAUNCHER`.
    `ccache statistics` in the log shows invocations and hit rate.
- Google Play: Actions → **Build Google Play bundle** (`build-store.yml`, by hand only) builds the store AAB
  (`DISTRIBUTION=store`, all four ABIs, `wtfai-play.aab`) and fails if its manifest asks for
  `REQUEST_INSTALL_PACKAGES` or an unused permission ([SPEC.md](SPEC.md) §2.2). Never published or
  announced.
- App Store: Actions → **Build App Store iOS App** (`build-ios-store.yml`, by hand only): the store build, signed and
  uploaded to App Store Connect when the `ASC_KEY_*` secrets or the certificate, profile and app-specific password
  secrets exist, else unsigned as a compile check. Run from `main`, a signed build registers its runtime, and the
  JS updates of `main` reach it ([OTA.md](OTA.md) → Store builds);
  fails on a library's generic purpose string or a missing privacy manifest
  ([SPEC.md](SPEC.md) §2.2). Its secrets are listed at the top of the workflow.
- CarPlay: **CarPlay Simulator** (`carplay-simulator.yml`), on pushes that change `modules/car-play/`,
  `src/components/car-play/` or its scripts (`.github/scripts/carplay/`), and by hand: a simulator build that claims
  the CarPlay entitlement, opened on the Simulator's CarPlay display; passes when the app is open there.
  Screenshots and logs are its artifact ([CARPLAY-SPEC.md](CARPLAY-SPEC.md) §6.2). Outside `ci.yml` and its plan.

## Changing the rules

Edit the path classes and `decide()` in `ci-plan.sh` and add a case to its self-test
(`.github/scripts/ci-plan.sh --test`, also run by the `plan` job).
