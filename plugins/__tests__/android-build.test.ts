// Config plugin: stable release signing key for sideloaded APKs (debug-key fallback), the lint setting, Gradle memory.

jest.mock("expo/config-plugins", () => ({
  withAppBuildGradle: (config: any, mod: (c: any) => any) => mod(config),
  withGradleProperties: (config: any, mod: (c: any) => any) => mod(config),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { patchGradle, patchGradleProperties } = require("../android-build.js");

// The relevant part of the SDK 57 prebuild template (android/app/build.gradle).
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe("android-build plugin", () => {
  test("adds a release signing config fed by environment variables and uses it for release", () => {
    const out = patchGradle(TEMPLATE);
    expect(out).toContain("System.getenv('ANDROID_KEYSTORE_PATH')");
    expect(out).toContain("keyAlias System.getenv('ANDROID_KEY_ALIAS')");
    expect(out).toContain("signingConfig System.getenv('ANDROID_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug");
  });

  test("keeps the debug build type on the debug key", () => {
    const out = patchGradle(TEMPLATE);
    expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug\s*\}/);
  });

  test("is idempotent", () => {
    const once = patchGradle(TEMPLATE);
    expect(patchGradle(once)).toBe(once);
  });

  test("turns off the ExtraTranslation lint check (iOS plist strings in locales/)", () => {
    expect(patchGradle(TEMPLATE)).toMatch(/lint \{\s*disable 'ExtraTranslation'\s*\}/);
  });

  test("fails loudly when the template changes shape", () => {
    expect(() => patchGradle("android {}")).toThrow(/signingConfigs.debug not found/);
  });

  test("gives Gradle and the Kotlin daemon more metaspace than the template, once", () => {
    const template = [
      { type: "comment", value: "Project-wide Gradle settings." },
      { type: "property", key: "org.gradle.jvmargs", value: "-Xmx2048m -XX:MaxMetaspaceSize=512m" },
      { type: "property", key: "android.useAndroidX", value: "true" },
    ];
    const out = patchGradleProperties(template);
    const value = (key: string) => out.filter((i: any) => i.key === key).map((i: any) => i.value);
    expect(value("org.gradle.jvmargs")).toEqual([expect.stringContaining("-XX:MaxMetaspaceSize=1536m")]);
    expect(value("kotlin.daemon.jvmargs")).toEqual([expect.stringContaining("-XX:MaxMetaspaceSize=1g")]);
    expect(value("android.useAndroidX")).toEqual(["true"]);
    expect(out[0]).toEqual(template[0]);
    expect(patchGradleProperties(out)).toEqual(out);
  });
});
