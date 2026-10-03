# wtf.ai

## Where the f\* am I?

wtf.ai is an iOS-first navigation prototype for drivers in Ukraine. Its goal is to keep a useful, trustworthy vehicle position when GNSS is jammed or spoofed, with offline maps and routing planned.

## Project status

This is an early development build, not a production navigation system. The current map displays the phone's live GNSS position. Spoofing-resistant position fusion, the OBDLink vehicle connection, offline maps, and offline routing are not implemented yet. Do not rely on the app for real-world or emergency navigation.

The app is built with Expo SDK 57, React Native, TypeScript, and Expo Router. It targets iOS first; development happens on Windows, and unsigned iOS builds come from GitHub Actions macOS runners (sideloaded with AltStore).

## Run the app

You need Node.js with npm. Expo Go is not supported because the app uses native modules; install the iOS development build on an iPhone.

1. Install project dependencies:

   ```bash
   npm install
   ```

2. Get an unsigned iOS build from GitHub Actions: every push runs the **CI** workflow, whose `build-ios` job uploads `wtfai-Release-unsigned.ipa` as an artifact. For a dev client, run **Build Unsigned iOS App** by hand with `Debug`.

3. Sideload the IPA with [AltStore](https://altstore.io) (free Apple ID; refresh the app every 7 days with AltServer). For a Debug build, start Metro on the same network:

   ```bash
   npx expo start --dev-client
   ```

No EAS, paid Apple Developer account, or Mac is needed.

## Checks

```bash
npx expo lint
npx tsc --noEmit
npx jest
python -m pytest tools/triplog          # after: pip install -e "tools/triplog[dev]"
python -m pytest tools/tiles            # after: pip install -e "tools/tiles[dev]"
swift test                              # Swift logic of the native modules; on Windows via Docker:
docker run --rm -v "$PWD:/src" -w /src swift:6.1 swift test --scratch-path /tmp/build
```

CI runs all of these plus `expo-doctor` and the unsigned iOS build on every push.

## Privacy

Position data stays on the device; there is no position upload. Standalone (Release) builds send crash reports to Sentry with personal data, coordinates, and VINs removed. During development, the online OpenFreeMap style requests reveal the map area being viewed. This temporary exception must be removed before non-development distribution by switching to offline map tiles.

## Project documents

- [Product specification](docs/SPEC.md)
- [UI milestone specification](docs/UI-SPEC.md)
- [Vehicle link (Bluetooth ELM327) specification](docs/VEHICLE-LINK-SPEC.md)
- [Trip logger milestone specification](docs/TRIP-LOGGER-SPEC.md)
- [Stage 1 navigator (EKF, calibration, replay) specification](docs/NAVIGATOR-SPEC.md)
