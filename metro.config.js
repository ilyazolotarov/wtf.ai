// Sentry's wrapper around Expo's default Metro config (adds debug IDs for source maps).
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
