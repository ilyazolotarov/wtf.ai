// Replaces expo/src/async-require/messageSocket.native.ts (see metro.config.js).
// Expo throws at startup when a __DEV__ bundle was not served by Metro, which crashes
// Debug IPAs launched with "Load embedded bundle". Only open the socket when there is a server.
const getDevServer = require("react-native/Libraries/Core/Devtools/getDevServer").default;

if (__DEV__ && getDevServer().bundleLoadedFromServer) {
  require("expo/src/async-require/messageSocket.native.ts");
}
