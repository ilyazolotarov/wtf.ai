// Release signing for sideloaded APKs (docs/ANDROID-SPEC.md §4). The prebuild template signs release with the debug key,
// which changes with every `prebuild --clean`: a tester could not update over the previous APK. With
// ANDROID_KEYSTORE_PATH (+ _PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD) set, release uses that stable key;
// without them it falls back to the debug key (fine for CI runs that are never sent to testers).
// Never edit android/ by hand; prebuild applies this.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// wtf.ai release signing";

const SIGNING_CONFIG = `        ${MARKER}
        release {
            def keystorePath = System.getenv('ANDROID_KEYSTORE_PATH')
            if (keystorePath) {
                storeFile file(keystorePath)
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_KEY_PASSWORD')
            }
        }
`;

function patchGradle(src) {
  if (src.includes(MARKER)) return src;
  // Add a `release` signing config after the template's `debug` one.
  const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\}\s*\n)/;
  if (!debugConfig.test(src)) throw new Error("android-signing: signingConfigs.debug not found in app/build.gradle");
  let out = src.replace(debugConfig, `$1${SIGNING_CONFIG}`);
  // Use it in the release build type when a keystore is configured.
  const releaseBlock = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
  if (!releaseBlock.test(out)) throw new Error("android-signing: release buildType signingConfig not found");
  out = out.replace(
    releaseBlock,
    "$1signingConfig System.getenv('ANDROID_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug",
  );
  return out;
}

module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = patchGradle(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.patchGradle = patchGradle;
