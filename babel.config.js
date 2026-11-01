// Worklets in Bundle Mode (react-native-worklets 0.13): a worker runtime runs this bundle's own modules, so the navigator
// runs off the JS thread as the same TypeScript the replay runs (docs/SPEC.md §6). babel-preset-expo adds the worklets
// plugin without options: it is off there and added here with them (Reanimated's plugin is the same one).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { worklets: false, reanimated: false }]],
    // Only src/workers' worklets import modules into a worker (relatively: the generated worklet file resolves no `@/`);
    // anything else they name stays the JS thread's.
    plugins: [["react-native-worklets/plugin", { bundleMode: true, strictGlobal: true, importForwarding: { relativePaths: ["src/workers"] } }]],
  };
};
