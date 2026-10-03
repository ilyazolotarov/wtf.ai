This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

**Product spec:** read [docs/SPEC.md](docs/SPEC.md) before any feature work — it defines architecture, decisions, phases, and conventions.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done. When touching native modules, also run the Swift logic tests (`swift test`, see README) and keep logic in `modules/*/ios/Logic/` so it stays testable without Xcode.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building — GitHub Actions, not EAS

**Do not use EAS Build, EAS Submit, or EAS Update, and do not suggest them.** There is no paid Apple Developer account and no Mac. iOS builds are made like this:

- `.github/workflows/ci.yml` runs on every push/PR: lint, typecheck, Jest, Python tests, `expo-doctor`, then calls `.github/workflows/build-ios.yml`.
- `build-ios.yml` runs `expo prebuild` + `xcodebuild` on a GitHub macOS runner with code signing disabled and uploads an **unsigned IPA** artifact (can also be started by hand: Actions → *Build Unsigned iOS App*, Release or Debug).
- The IPA is sideloaded with **AltStore** (re-signed with a free Apple ID: the app expires after 7 days and must be refreshed via AltServer on Windows).
- The CI build is the only native compiler available: a Swift or config-plugin mistake shows up as a failed `build-ios` job. Read its log; there is no local Xcode.
- Release builds embed the JS bundle (standalone). Debug builds are a dev client that needs Metro (`npx expo start`) on the same LAN.

`eas.json` is a leftover and is not used.

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a new native build: push and use the IPA from the CI `build-ios` job (see above).
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
