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
| `build-ios` (unsigned IPA)            | see below                                                                   |

## Builds

"Native" here: `modules/*/ios/` (iOS) or `modules/*/android/` (Android), and for both
`app.json`, `package.json`, `package-lock.json`, `patches/`, `plugins/`, `metro.config.js`, module
`app.plugin.js` / `expo-module.config.json` and the platform's build workflow.

| Event                                  | Build                                    | Telegram | Kept    |
| -------------------------------------- | ---------------------------------------- | -------- | ------- |
| Push to a branch, native change        | Debug, as a compile check                | no       | 7 days  |
| Push to a branch, `[build]` in a commit message | Debug                           | yes      | 7 days  |
| Push to a branch, anything else        | none                                     | —        | —       |
| Push to `main` changing app code (`src/`, `assets/`, `locales/`, native, …) | Debug | yes | 14 days |
| Push to `main`, docs/tools only        | none                                     | —        | —       |
| Pull request from a fork               | native change → Debug compile check      | no       | 7 days  |
| Manual: Actions → **CI** → Run workflow | iOS: Debug / Release / none; all checks | yes      | 14 days |
| Manual: Actions → **Build Unsigned iOS App** | the chosen configuration, no checks | optional | 14 days |

Keywords, in any commit message of a push: `[build]` (both platforms), `[build ios]`, `[build android]`.
GitHub's own `[skip ci]` skips the run entirely.

`main` builds Debug (dev client with the JS bundle embedded) for now, and will switch to Release later.

Pull requests from branches of this repo don't run CI again: their branch pushes already did.

## Caches (iOS build)

- npm (`setup-node`).
- CocoaPods download cache (`~/Library/Caches/CocoaPods`: pod sources, prebuilt React Native and
  Hermes tarballs), keyed on `package-lock.json`, `patches/` and module podspecs.
- ccache (`~/ccache`, set in React Native's `ccache.conf`) for the C/C++/Objective-C of the pods (`USE_CCACHE=1`, read by the Expo Podfile). React Native
  core and Expo modules come precompiled; Swift is not cached. The build log prints the hit rate
  (`ccache statistics`).

Caches are **saved only by `main`** and restored everywhere: branches start from `main`'s caches and
their builds don't evict them (the repo has 10 GB of cache).

## Android

Android (the `android` branch, docs/ANDROID-SPEC.md) plugs into the same plan: `ci-plan.sh`
already outputs `build_android` (`ci` on `main` and for Android-native changes or `[build android]` on
branches, empty otherwise). When `android` is merged, its `build-android` job in `ci.yml` takes:

```yaml
  build-android:
    needs: [plan, checks]
    if: ${{ !cancelled() && needs.plan.outputs.build_android != '' && needs.checks.result == 'success' }}
    uses: ./.github/workflows/build-android.yml
    with:
      variant: ${{ needs.plan.outputs.build_android }}
    secrets: inherit
```

plus an `android` choice (`none` / `ci` / `tester`) on `workflow_dispatch` passed to the plan as
`DISPATCH_ANDROID`, and Gradle cache saves limited to `main`, as for iOS (`setup-gradle` already
only writes from the default branch).

## Changing the rules

Edit the path classes and `decide()` in `ci-plan.sh` and add a case to its self-test
(`.github/scripts/ci-plan.sh --test`, also run by the `plan` job).
