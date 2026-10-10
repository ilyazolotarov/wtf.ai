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
| `checks` (lint, tsc, Jest, doctor)    | anything except docs (`docs/`, `*.md`, `.claude/`, …), or a build runs      |
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
GitHub's own `[skip ci]` skips the run entirely.

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

## Changing the rules

Edit the path classes and `decide()` in `ci-plan.sh` and add a case to its self-test
(`.github/scripts/ci-plan.sh --test`, also run by the `plan` job).
