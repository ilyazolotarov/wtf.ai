# OTA: JS updates without reinstalling

A JS-only change reaches installed Release builds without a new IPA/APK: `expo-updates` in the app, our own
update server, no EAS. Native changes still need a new build from CI ([CI.md](CI.md)).

Status: the app side and the update builder (`tools/ota/`) are in place. Still to come: the Worker that serves
updates, the CI step that publishes them, `main` building Release, and the update id in the app and trip logs.

## Rules

- **Release builds only.** `expo-updates` is off in Debug builds (the dev client loads its JS itself), so `main`
  builds Release; a branch with `[build]` still gives a Debug dev client for Metro.
- **Runtime version = fingerprint** (`runtimeVersion.policy` in `app.json`): a hash of everything native (Expo SDK,
  native modules, config plugins, `patches/`, `app.json`, `.gitignore`, …). An update goes only to builds with
  exactly its runtime version, so JS can never land on a binary without the native code it needs. Resolve it in CI
  (Linux/macOS), never on Windows: line endings change it.
- **Signed.** The app accepts only updates signed with the key of `certs/certificate.pem`
  (`rsa-v1_5-sha256`, keyid `main`). The private key never enters the repo: it lives with the owner and in the
  `OTA_SIGNING_KEY` CI secret. A new certificate means a new native build, and phones on the old one take no
  updates until they install it.
- **Never mid-drive.** The app checks at launch without waiting (`fallbackToCacheTimeout: 0`); a downloaded update
  runs from the next cold start. The app never calls `reloadAsync()` on its own.
- **Recovery.** A bundle that crashes at launch makes `expo-updates` fall back to the previous one or the embedded
  one. The server can also send a signed `rollBackToEmbedded` directive.

## Making an update

```bash
npx expo export --platform ios --platform android
OTA_SIGNING_KEY="$(cat private-key.pem)" npm run ota:prepare     # → ota-out/
```

`ota-out/` holds what the Worker serves:

- `assets/<key>`: every file of the updates (bundle, fonts, images, voice), named by its SHA-256 (hex). A file is
  uploaded once and never changed or removed while an update uses it: the client checks each download against the
  hash in the signed manifest.
- `updates/<runtimeVersion>/<platform>/<id>.json`: `{manifest, signature}`. The Worker serves `manifest`
  byte for byte with `signature` as its `expo-signature` header: re-serializing the JSON breaks the signature.

The update id is a digest of the runtime version, the platform and every file, so the same JS exported twice is the
same update and phones download nothing. `Constants.expoConfig` inside an update comes from the manifest
(`extra.expoClient`, the public Expo config at export time).
