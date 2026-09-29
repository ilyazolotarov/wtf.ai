# wtf.ai

## Where the f\* am I?

wtf.ai is an iOS-first navigation prototype for drivers in Ukraine. Its goal is to keep a useful, trustworthy vehicle position when GNSS is jammed or spoofed, with offline maps and routing planned.

## Project status

This is an early development build, not a production navigation system. The current map displays the phone's live GNSS position. Spoofing-resistant position fusion, the OBDLink vehicle connection, offline maps, and offline routing are not implemented yet. Do not rely on the app for real-world or emergency navigation.

The app is built with Expo SDK 57, React Native, TypeScript, and Expo Router. It targets iOS first; development and iOS builds are set up for Windows using EAS Build in the cloud.

## Run the app

You need Node.js with npm. Expo Go is not supported because the app uses native modules; install the iOS development build on an iPhone.

1. Install project dependencies:

   ```bash
   npm install
   ```

2. Build the iOS development app in the cloud (requires an Expo account and Apple signing setup):

   ```bash
   npx eas-cli@latest build --platform ios --profile development
   ```

3. Install the build on your registered iPhone, then start the development server:

   ```bash
   npx expo start --dev-client
   ```

## Checks

```bash
npx expo lint
npx tsc --noEmit
npx jest
```

## Privacy

Position data stays on the device; the app has no telemetry or position upload. During development, the online OpenFreeMap style requests reveal the map area being viewed. This temporary exception must be removed before non-development distribution by switching to offline map tiles.

## Project documents

- [Product specification](docs/SPEC.md)
- [UI milestone specification](docs/UI-SPEC.md)
