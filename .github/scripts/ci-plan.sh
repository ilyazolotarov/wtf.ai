#!/usr/bin/env bash
# Decides which CI jobs a run needs (docs/CI.md). Called by the `plan` job of ci.yml; writes
# key=value lines to $GITHUB_OUTPUT (stdout when unset).
#
# What changed is diffed against the last commit this branch fully passed CI on, so a run that
# was cancelled by a newer push, or failed, is covered again by the next one.
#
# Env: EVENT (push | pull_request | workflow_dispatch), REF_NAME, DEFAULT_BRANCH, BEFORE (push),
#      PR_BASE_SHA (pull_request), DISPATCH_IOS / DISPATCH_ANDROID (workflow_dispatch),
#      GH_TOKEN + GITHUB_REPOSITORY (to look up earlier runs; optional).
#
# Self-test: .github/scripts/ci-plan.sh --test
set -euo pipefail

ZERO_SHA=0000000000000000000000000000000000000000

# --- Path classes -------------------------------------------------------------------------------
# `case` globs: `*` also matches `/`.

# Never affects the app or its tests.
is_docs() {
  case "$1" in
    docs/* | *.md | LICENSE | .claude/* | vibeview.json | skills-lock.json | eas.json) return 0 ;;
  esac
  return 1
}

# Native build inputs shared by both platforms: prebuild config, native deps, bundling.
is_native_shared() {
  case "$1" in
    app.json | package.json | package-lock.json | patches/* | plugins/* | metro.config.js | \
      modules/*/app.plugin.js | modules/*/expo-module.config.json | \
      fingerprint.config.js | .fingerprintignore | certs/*) return 0 ;;
  esac
  return 1
}

is_ios_native() {
  is_native_shared "$1" && return 0
  case "$1" in
    modules/*/ios/* | .github/workflows/build-ios.yml) return 0 ;;
  esac
  return 1
}

is_android_native() {
  is_native_shared "$1" && return 0
  case "$1" in
    modules/*/android/* | native-tests-android/* | \
      .github/workflows/build-android.yml) return 0 ;;
  esac
  return 1
}

# Code that ends up in the app (JS bundle or native): a change here means a new build for `main`.
is_app() {
  is_ios_native "$1" || is_android_native "$1" && return 0
  case "$1" in
    src/* | assets/* | locales/* | metro/* | tsconfig.json) return 0 ;;
  esac
  return 1
}

is_swift_logic() {
  case "$1" in
    modules/*/ios/* | native-tests/* | Package.swift) return 0 ;;
  esac
  return 1
}

is_kotlin_logic() {
  case "$1" in
    modules/*/android/* | native-tests-android/*) return 0 ;;
  esac
  return 1
}

is_python() {
  case "$1" in
    tools/triplog/* | tools/tiles/*) return 0 ;;
  esac
  return 1
}

# classify <files on stdin> → sets CHECKS PYTHON SWIFT KOTLIN IOS_NATIVE ANDROID_NATIVE APP (true/false)
classify() {
  CHECKS=false PYTHON=false SWIFT=false KOTLIN=false IOS_NATIVE=false ANDROID_NATIVE=false APP=false
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_docs "$f" || CHECKS=true
    is_python "$f" && PYTHON=true
    is_swift_logic "$f" && SWIFT=true
    is_kotlin_logic "$f" && KOTLIN=true
    is_ios_native "$f" && IOS_NATIVE=true
    is_android_native "$f" && ANDROID_NATIVE=true
    is_app "$f" && APP=true
  done
  return 0
}

# Build keyword in commit messages: [build] = both platforms, [build ios], [build android].
keyword_wants() { # <platform> <messages on stdin>
  grep -qiE "\[build( $1)?\]"
}

# --- Decision -----------------------------------------------------------------------------------

# decide → sets BUILD_IOS ('' | Debug | Release), BUILD_ANDROID ('' | ci | tester), OTA (the platforms to publish a JS
# update for: '' | "ios" | "android" | "ios android"), NOTIFY, RETENTION
# from EVENT, REF_NAME, DEFAULT_BRANCH, the classify() flags, MESSAGES and DISPATCH_*.
decide() {
  BUILD_IOS='' BUILD_ANDROID='' OTA='' NOTIFY=false RETENTION=7
  case "$EVENT" in
    workflow_dispatch)
      [ "${DISPATCH_IOS:-none}" != none ] && BUILD_IOS=$DISPATCH_IOS
      [ "${DISPATCH_ANDROID:-none}" != none ] && BUILD_ANDROID=$DISPATCH_ANDROID
      NOTIFY=true RETENTION=14
      ;;
    pull_request) # forks only: compile checks, never delivered
      $IOS_NATIVE && BUILD_IOS=Debug
      $ANDROID_NATIVE && BUILD_ANDROID=ci
      ;;
    push)
      if [ "$REF_NAME" = "$DEFAULT_BRANCH" ]; then
        # What is on main is what goes on the phone. A native change needs a new Release build (which takes the JS
        # updates after it); JS alone goes over the air to the builds already installed (docs/OTA.md).
        if $APP; then
          NOTIFY=true RETENTION=14
          if $IOS_NATIVE; then BUILD_IOS=Release; else OTA=ios; fi
          if $ANDROID_NATIVE; then BUILD_ANDROID=ci; else OTA="${OTA:+$OTA }android"; fi
        fi
      else
        # Branches: native changes are compiled (CI is the only Xcode/Gradle); an IPA/APK to
        # install is asked for with the keyword.
        if keyword_wants ios <<<"$MESSAGES"; then BUILD_IOS=Debug NOTIFY=true; fi
        if keyword_wants android <<<"$MESSAGES"; then BUILD_ANDROID=ci NOTIFY=true; fi
        if $IOS_NATIVE && [ -z "$BUILD_IOS" ]; then BUILD_IOS=Debug; fi
        if $ANDROID_NATIVE && [ -z "$BUILD_ANDROID" ]; then BUILD_ANDROID=ci; fi
      fi
      ;;
  esac
  # Nothing to compile or publish without the checks: a build or an update always runs them too.
  if [ -n "$BUILD_IOS$BUILD_ANDROID$OTA" ]; then CHECKS=true; fi
  return 0
}

# --- Base commit --------------------------------------------------------------------------------

# Newest commit of this branch whose push run of this workflow succeeded, if it is in HEAD's history.
last_green() {
  [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] || return 1
  local sha
  for sha in $(gh run list -R "$GITHUB_REPOSITORY" --workflow ci.yml --branch "$REF_NAME" \
    --event push --status success --limit 30 --json headSha --jq '.[].headSha' 2>/dev/null); do
    if git merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
      echo "$sha"
      return 0
    fi
  done
  return 1
}

find_base() {
  case "$EVENT" in
    pull_request) git merge-base "$PR_BASE_SHA" HEAD 2>/dev/null ;;
    push)
      last_green && return 0
      if [ "$REF_NAME" != "$DEFAULT_BRANCH" ]; then
        git merge-base "origin/$DEFAULT_BRANCH" HEAD 2>/dev/null
      elif [ -n "${BEFORE:-}" ] && [ "$BEFORE" != "$ZERO_SHA" ] &&
        git merge-base --is-ancestor "$BEFORE" HEAD 2>/dev/null; then
        echo "$BEFORE"
      fi
      ;;
  esac
  return 0
}

plan() {
  echo "checks=$CHECKS"
  echo "python=$PYTHON"
  echo "swift=$SWIFT"
  echo "kotlin=$KOTLIN"
  echo "build_ios=$BUILD_IOS"
  echo "build_android=$BUILD_ANDROID"
  echo "ota=$OTA"
  echo "notify=$NOTIFY"
  echo "retention=$RETENTION"
}

main() {
  if [ "$EVENT" = workflow_dispatch ]; then
    # Manual run: everything checked, builds as chosen.
    CHECKS=true PYTHON=true SWIFT=true KOTLIN=true IOS_NATIVE=false ANDROID_NATIVE=false APP=false MESSAGES=''
    echo "Manual run: all checks"
  else
    local base
    base=$(find_base)
    if [ -z "$base" ]; then
      echo "No base commit found: treating every file as changed"
      git ls-files | classify
      MESSAGES=$(git log -1 --format=%B HEAD)
    else
      echo "Changes since $base:"
      git diff --name-only "$base" HEAD | sed 's/^/  /'
      classify < <(git diff --name-only "$base" HEAD)
      MESSAGES=$(git log --format=%B "$base..HEAD")
    fi
  fi
  decide
  echo "Plan:"
  plan | sed 's/^/  /'
  if [ -n "${GITHUB_OUTPUT:-}" ]; then plan >>"$GITHUB_OUTPUT"; fi
  return 0
}

# --- Self-test ----------------------------------------------------------------------------------

self_test() {
  local fails=0
  # expect <description> <expected "checks python swift build_ios build_android notify ota"> <event> <ref> <messages> <files...>
  # (ota: the platforms joined by +, or -)
  expect() {
    local desc=$1 want=$2
    EVENT=$3 REF_NAME=$4 MESSAGES=$5 DEFAULT_BRANCH=main
    shift 5
    classify < <(printf '%s\n' "$@")
    decide
    local ota=${OTA// /+}
    local got="$CHECKS $PYTHON $SWIFT ${BUILD_IOS:--} ${BUILD_ANDROID:--} $NOTIFY ${ota:--}"
    if [ "$got" = "$want" ]; then
      echo "ok   $desc"
    else
      echo "FAIL $desc: want '$want', got '$got'"
      fails=$((fails + 1))
    fi
  }
  expect "docs only on a branch" "false false false - - false -" push b "" docs/SPEC.md README.md
  expect "docs only on main" "false false false - - false -" push main "" docs/SPEC.md
  expect "JS on a branch: checks only" "true false false - - false -" push b "" src/app/index.tsx
  expect "JS on a branch with [build]" "true false false Debug ci true -" push b "Fix x [build]" src/app/index.tsx
  expect "JS on a branch with [build ios]" "true false false Debug - true -" push b "x [Build iOS]" src/a.ts
  expect "JS on a branch with [build android]" "true false false - ci true -" push b "x [build android]" src/a.ts
  expect "docs on a branch with [build]" "true false false Debug ci true -" push b "[build]" docs/x.md
  expect "Swift module on a branch" "true false true Debug - false -" push b "" modules/vehicle-link/ios/Link.swift
  expect "Kotlin module on a branch" "true false false - ci false -" push b "" modules/vehicle-link/android/src/A.kt
  expect "app.json on a branch: both" "true false false Debug ci false -" push b "" app.json
  expect "Python tools on a branch" "true true false - - false -" push b "" tools/tiles/tiles/graph.py
  expect "replay tools (TS) on a branch" "true false false - - false -" push b "" tools/replay/cli.ts
  expect "JS on main: an OTA update, no builds" "true false false - - true ios+android" push main "" src/a.ts
  expect "app.json on main: Release builds, no update" "true false false Release ci true -" push main "" app.json src/a.ts
  expect "Swift module on main: iOS build, Android update" "true false true Release - true android" push main "" modules/a/ios/A.swift
  expect "Kotlin module on main: Android build, iOS update" "true false false - ci true ios" push main "" modules/a/android/A.kt
  expect "signing certificate on main: builds" "true false false Release ci true -" push main "" certs/certificate.pem
  expect "fingerprint config on main: builds" "true false false Release ci true -" push main "" fingerprint.config.js
  expect "OTA tools on main: nothing to ship" "true false false - - false -" push main "" tools/ota/prepare.ts
  expect "Python on main: no build" "true true false - - false -" push main "" tools/triplog/x.py
  expect "native on a fork PR" "true false true Debug - false -" pull_request x "[build]" modules/a/ios/A.swift
  expect "JS on a fork PR: keyword ignored" "true false false - - false -" pull_request x "[build]" src/a.ts
  # Kotlin logic tests run for Android module/test changes only (expect_kotlin <description> <true|false> <file>).
  local kt
  for kt in "true modules/sensor-capture/android/src/main/java/A.kt" "true native-tests-android/build.gradle.kts" "false modules/sensor-capture/ios/A.swift" "false src/a.ts"; do
    classify < <(printf '%s
' "${kt#* }")
    if [ "$KOTLIN" = "${kt%% *}" ]; then echo "ok   kotlin=$KOTLIN for ${kt#* }"; else echo "FAIL kotlin for ${kt#* }: want ${kt%% *}"; fails=$((fails + 1)); fi
  done
  DISPATCH_IOS=Release DISPATCH_ANDROID=none
  expect "manual Release" "true false false Release - true -" workflow_dispatch b ""
  if [ "$fails" -ne 0 ]; then
    echo "$fails failed"
    return 1
  fi
  echo "all passed"
}

if [ "${1:-}" = --test ]; then
  self_test
else
  main
fi
