# wtf.ai

## Where the f\* am I?

wtf.ai is a navigation app for drivers in Ukraine that keeps a trustworthy car position when GNSS is jammed or spoofed. Maps, routing and address search work offline from one downloaded region.

## Project status

A development build, field-tested in one car (and a few drives in a second) with one phone. It is not a production navigation system: do not rely on it for emergency navigation.

What works:

- **Vehicle link:** an OBD-II adapter over Bluetooth, MFi (OBDLink MX+) or BLE ELM327 (tested: vLinker FD-IOS). Speed is polled at 25–30 Hz on the test car.
- **Position without GPS:** dead reckoning from OBD speed and the phone gyro, fused with GNSS in an EKF that calibrates itself while driving. The pose at engine-off starts the next drive.
- **Spoofing:** fixes outside Ukraine, or ones that jump away from where the car could be, are refused, and the map says so.
- **Map matching:** a particle filter holds the position on the road network while GPS is out, and shows other roads the car may be on.
- **Putting the car on the map:** the driver can set the position and heading by hand while the car stands.
- **Offline maps** per region, downloaded from GitHub releases, with **address search**.
- **Routing:** turn-by-turn with spoken directions (Ukrainian, English), re-planning when the car leaves the route, alternative routes, and travel times from speed limits, settlements, traffic lights and rush hours in big cities. No live traffic: none is available for Ukraine.
- **Trip logs:** every drive is recorded automatically and can be replayed on a PC, the same code the app runs; opt-in upload for testers.
- **In-app guide:** onboarding, a map tour and interactive lessons.
- **Android:** an APK for volunteer testers, tested on emulators; Bluetooth on Android hasn't met a real adapter yet.
- **Without an adapter** (experimental, a developer setting): the phone's own speed estimate and turn-based map matching, with the driver placing the car.

Not yet: CAN wheel speeds and yaw rate (Stages 2–3 of [the spec](docs/SPEC.md)), waking the app when the car starts, and a logged drive with real spoofing (integrity is tuned on simulated spoofs).

Built with Expo SDK 57, React Native, TypeScript and Expo Router. Development happens on Windows; unsigned iOS builds come from GitHub Actions macOS runners and are sideloaded with AltStore. Android APKs come from the same CI ([docs/ANDROID-TESTING.md](docs/ANDROID-TESTING.md)).

## Configuration: your own servers

The repo names no server or account of its own, so a fork builds against its own without code changes. They come
from the environment: in CI, GitHub repository variables (Settings → Secrets and variables → Actions → Variables);
locally, `.env.local` (git-ignored, loaded by Expo). Every one is optional: without it, its feature is off.

| Variable | What | Without it |
| --- | --- | --- |
| `UPDATES_ORIGIN` | the update Worker (`workers/app-updates`): JS updates, builds, AltStore source, maps ([docs/OTA.md](docs/OTA.md)) | no OTA updates, no update checks; maps from the repo's GitHub releases |
| `TRIP_UPLOAD_ORIGIN` | the trip log upload Worker (`workers/triplog-upload`) | no upload in the Trip recorder |
| `SENTRY_DSN` | where crash reports go | no crash reports |
| `SENTRY_URL`, `SENTRY_ORG`, `SENTRY_PROJECT` (+ secret `SENTRY_AUTH_TOKEN`) | source map / dSYM uploads (`SENTRY_URL` is the region, e.g. the EU one) | minified JS stack traces |
| `MAP_RELEASES_REPO` (local only) | `owner/repo` of the `maps-*` releases; CI uses its own repo | — |

They are built into the app and are part of the OTA runtime version (`app.config.js`): changing one needs a native
build. The Workers get their own domains at deploy, on every deploy (`--domain`, not through `npm run`: PowerShell eats
its `--`): `npx wrangler deploy --config workers/app-updates/wrangler.toml --domain <host>`, and the same with
`workers/triplog-upload/wrangler.toml` (each keeps its `workers.dev` address for builds made without a domain).

## Run the app

You need Node.js with npm. Expo Go is not supported (the app has its own native modules): install a build from CI.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Get an unsigned iOS build from GitHub Actions ([docs/CI.md](docs/CI.md)): the **CI** workflow's `build-ios` job uploads `wtfai-Release-unsigned.ipa` for every push to `main` that changes native code, and `wtfai-Debug-unsigned.ipa` (a dev client with the JS bundle embedded) for branch pushes with `[build]` in a commit message. JS-only pushes to `main` reach an installed Release build over the air instead ([docs/OTA.md](docs/OTA.md)): restart the app twice. You can also run **CI** or **Build Unsigned iOS App** by hand.

   Optional: a Telegram message for every build (branch compile checks are not sent).
   1. In Telegram, create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
   2. Send the bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `"chat":{"id":…}`.
   3. Add both as repository secrets: `gh secret set TELEGRAM_BOT_TOKEN`, then `gh secret set TELEGRAM_CHAT_ID` (each prompts for the value).

   Every build then sends a message, never the file: `main`'s builds with their download links (IPA, APK, AltStore source), branch builds with the link to the run whose artifacts hold them. Builds without the secrets skip the step.

3. Sideload the IPA with [AltStore](https://altstore.io) (free Apple ID; refresh the app every 7 days with AltServer). To get `main`'s builds as AltStore updates, add our source once: in the app, More → App update → Open AltStore (or AltStore → Sources → + → `<update server>/altstore.json`, the server being the `UPDATES_ORIGIN` repository variable; [docs/UPDATES-SPEC.md](docs/UPDATES-SPEC.md)). For a Debug build, start Metro on the same network:

   ```bash
   npx expo start --dev-client
   ```

   Fast refresh updates screens; services created at app start (route, navigator, recorder) keep their old code until a full reload (`r` in the Metro terminal).

4. On first start the app asks for a map region: download one in the app. Without an adapter the map runs on the phone's GPS.

No EAS, paid Apple Developer account or Mac is needed.

## Checks

```bash
npx expo lint
npx tsc --noEmit
npx jest
python -m pytest tools/triplog          # after: pip install -e "tools/triplog[dev]"
python -m pytest tools/tiles            # after: pip install -e "tools/tiles[dev]"
swift test                              # Swift logic of the native modules; on Windows via Docker:
docker run --rm -v "$PWD:/src" -w /src swift:6.1 swift test --scratch-path /tmp/build
docker run --rm -v "$PWD:/src" -w /src/native-tests-android gradle:8.14-jdk17 gradle test   # Kotlin logic
```

CI runs these plus `expo-doctor` and the iOS and Android builds, each when what it covers changed ([docs/CI.md](docs/CI.md)).

## PC tools

- `tools/replay`: replays trip logs through the app's navigator, benchmarks, a browser viewer of drives, route planning and route-time checks ([README](tools/replay/README.md)).
- `tools/tiles`: builds the offline map release: vector tiles, road graph, search index ([README](tools/tiles/README.md)).
- `tools/triplog`: Python reader of the trip logs, and the log backup ([README](tools/triplog/README.md)).

## Privacy

Position data stays on the device; there is no position upload. Trip logs leave the phone only when the user shares them, or with the opt-in upload to the project's private bucket. Crash and error reports go to Sentry with personal data, coordinates and VINs removed. The map is offline only: a region is downloaded once from GitHub releases, and the app asks for one before it can be used.

## Project documents

- [Product specification](docs/SPEC.md): architecture, decisions, phases, conventions
- [UI](docs/UI-SPEC.md)
- [Vehicle link (Bluetooth ELM327)](docs/VEHICLE-LINK-SPEC.md)
- [Trip logger](docs/TRIP-LOGGER-SPEC.md)
- [Navigator (EKF, calibration, integrity, replay)](docs/NAVIGATOR-SPEC.md)
- [Map matching (road graph, particle filter)](docs/MAPMATCH-SPEC.md)
- [Routing](docs/ROUTING-SPEC.md)
- [Address search](docs/SEARCH-SPEC.md)
- [Android](docs/ANDROID-SPEC.md) and its [tester guide](docs/ANDROID-TESTING.md)
- [CI](docs/CI.md)
