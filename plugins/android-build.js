// Gradle tweaks for the Android build (docs/ANDROID-SPEC.md §4). 1) Release signing for sideloaded APKs. The prebuild template signs release with the debug key,
// which changes with every `prebuild --clean`: a tester could not update over the previous APK. With
// ANDROID_KEYSTORE_PATH (+ _PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD) set, release uses that stable key;
// without them it falls back to the debug key (fine for CI runs that are never sent to testers).
// 3) More memory for Gradle: expo-updates' code generation (KSP) runs out of the template's 512 MB metaspace, and
// Gradle then hangs until the job times out instead of failing.
// Never edit android/ by hand; prebuild applies this.
const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

const MARKER = "// wtf.ai release signing";
const LINT_MARKER = "// wtf.ai lint";

// 2) locales/*.json hold iOS Info.plist strings (NSLocationWhenInUseUsageDescription, ...); expo-localization also writes
// them as Android string resources for en/uk, with no default-locale copy, which release lint reports as errors.
// Android never reads them, so that one check is off.
const LINT_CONFIG = `    ${LINT_MARKER}
    lint {
        disable 'ExtraTranslation'
    }
`;

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

function patchLint(src) {
  if (src.includes(LINT_MARKER)) return src;
  const signingBlock = /\n(    signingConfigs\s*\{)/;
  if (!signingBlock.test(src)) throw new Error("android-build: signingConfigs not found in app/build.gradle");
  return src.replace(signingBlock, `\n${LINT_CONFIG}$1`);
}

function patchSigning(src) {
  if (src.includes(MARKER)) return src;
  // Add a `release` signing config after the template's `debug` one.
  const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\}\s*\n)/;
  if (!debugConfig.test(src)) throw new Error("android-build: signingConfigs.debug not found in app/build.gradle");
  let out = src.replace(debugConfig, `$1${SIGNING_CONFIG}`);
  // Use it in the release build type when a keystore is configured.
  const releaseBlock = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;
  if (!releaseBlock.test(out)) throw new Error("android-build: release buildType signingConfig not found");
  out = out.replace(
    releaseBlock,
    "$1signingConfig System.getenv('ANDROID_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug",
  );
  return out;
}

function patchGradle(src) {
  return patchLint(patchSigning(src));
}

// The CI runner has 16 GB: Gradle's own JVM and the Kotlin compile daemon each get room for the code generators.
const GRADLE_PROPERTIES = {
  "org.gradle.jvmargs": "-Xmx4g -XX:MaxMetaspaceSize=1536m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8",
  "kotlin.daemon.jvmargs": "-Xmx3g -XX:MaxMetaspaceSize=1g",
};

/** Sets GRADLE_PROPERTIES in gradle.properties (a list of {type, key, value} items), replacing the template's values. */
function patchGradleProperties(items) {
  const out = items.filter((item) => !(item.type === "property" && item.key in GRADLE_PROPERTIES));
  for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) out.push({ type: "property", key, value });
  return out;
}

module.exports = function withAndroidBuild(config) {
  config = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = patchGradle(cfg.modResults.contents);
    return cfg;
  });
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = patchGradleProperties(cfg.modResults);
    return cfg;
  });
};
module.exports.patchGradle = patchGradle;
module.exports.patchGradleProperties = patchGradleProperties;
