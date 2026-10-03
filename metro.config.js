// Sentry's wrapper around Expo's default Metro config (adds debug IDs for source maps).
const path = require("path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

// Expo's dev message socket throws at startup when a __DEV__ bundle is embedded (Debug IPA
// launched without Metro). Route Expo.fx's import of it through a guard that loads the original
// only when Metro serves the bundle. Keyed by importer, so the guard's own require is untouched.
const EXPO_FX = /[\\/]node_modules[\\/]expo[\\/]src[\\/]Expo\.fx\.tsx$/;
const MESSAGE_SOCKET_GUARD = path.resolve(__dirname, "metro/expo-message-socket.native.js");

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform !== "web" &&
    moduleName === "./async-require/messageSocket" &&
    EXPO_FX.test(context.originModulePath)
  ) {
    return { type: "sourceFile", filePath: MESSAGE_SOCKET_GUARD };
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
