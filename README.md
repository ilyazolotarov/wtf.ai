# wtf.ai

## Where the f\* am I?

wtf.ai is an iOS-first navigation prototype for drivers in Ukraine. It keeps a useful, trustworthy vehicle position when GNSS is jammed or spoofed, with offline maps, routing and address search.

## Project status

This is a development build, field-tested in one car, not a production navigation system. Do not rely on it for emergency navigation.

What works (Stage 1 of [the spec](docs/SPEC.md)):

- **Vehicle link:** an OBD-II adapter over Bluetooth, either MFi (OBDLink MX+) or BLE ELM327 (tested: vLinker FD-IOS). Speed is polled at ~27 Hz on the test car.
- **Position without GPS:** dead reckoning that fuses OBD speed and the phone gyro with GNSS, and calibrates itself while driving.
- **Spoofing:** fixes outside Ukraine, or ones that jump away from where the car could be, are refused.
- **Map matching:** the position is held on the road network while GPS is out.
- **Offline data:** map, routing (spoken turn-by-turn) and address search, all from one downloaded region.
- **Trip logs:** each drive is recorded automatically, and the logs can be replayed on a PC.
- **Android:** an APK for volunteer testers.

Not yet: CAN wheel speeds and yaw rate (Stages 2–3), and waking the app when the car starts.

The app is built with Expo SDK 57, React Native, TypeScript, and Expo Router. It targets iOS first; development happens on Windows, and unsigned iOS builds come from GitHub Actions macOS runners (sideloaded with AltStore). Android APKs come from the same CI ([docs/ANDROID-TESTING.md](docs/ANDROID-TESTING.md)).

## Run the app

You need Node.js with npm. Expo Go is not supported because the app uses native modules; install the iOS development build on an iPhone.

1. Install project dependencies:

   ```bash
   npm install
   ```

2. Get an unsigned iOS build from GitHub Actions: the **CI** workflow's `build-ios` job uploads `wtfai-Debug-unsigned.ipa` (a dev client with the JS bundle embedded) as an artifact for every push to `main` that changes the app, for branch pushes with `[build]` in a commit message, and when you run **CI** by hand ([docs/CI.md](docs/CI.md)). For a Release build (production JS, no dev client), run **Build Unsigned iOS App** by hand with `Release`.

   Optional: get these IPAs in Telegram as soon as they're built (branch compile checks are not sent).
   1. In Telegram, create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
   2. Send the bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `"chat":{"id":…}`.
   3. Add both as repository secrets: `gh secret set TELEGRAM_BOT_TOKEN`, then `gh secret set TELEGRAM_CHAT_ID` (each prompts for the value).

   Every build then sends the IPA with the branch, commit and run link. Builds without the secrets skip the step.

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

CI runs these plus `expo-doctor` and the unsigned iOS build, each when what it covers changed ([docs/CI.md](docs/CI.md)).

## Privacy

Position data stays on the device; there is no position upload. Crash and error reports go to Sentry with personal data, coordinates, and VINs removed. The map is offline only: a region is downloaded once from GitHub releases, and the app asks for one before it can be used.

## Project documents

- [Product specification](docs/SPEC.md)
- [UI milestone specification](docs/UI-SPEC.md)
- [Vehicle link (Bluetooth ELM327) specification](docs/VEHICLE-LINK-SPEC.md)
- [Trip logger milestone specification](docs/TRIP-LOGGER-SPEC.md)
- [Stage 1 navigator (EKF, calibration, replay) specification](docs/NAVIGATOR-SPEC.md)
- [Map matching (road graph, particle filter) specification](docs/MAPMATCH-SPEC.md)
- [Routing specification](docs/ROUTING-SPEC.md)
- [Address search specification](docs/SEARCH-SPEC.md)
- [Android specification](docs/ANDROID-SPEC.md) and [tester guide](docs/ANDROID-TESTING.md)
- [CI](docs/CI.md)
