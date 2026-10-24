// This app's build number (Android versionCode, iOS CFBundleVersion). expo-constants dropped `nativeBuildVersion`
// (SDK 51; it stayed undefined), and expo-application would need a native build, which installed apps don't have:
// Sentry's native module, in every build since the first, reads the same value from the package info / Info.plist.
// Also copied as is into old builds' JS by tools/ota/backports/native-build-number.mjs: keep it self-contained.
import { TurboModuleRegistry, type TurboModule } from "react-native";

interface RNSentry extends TurboModule {
  fetchNativeRelease(): Promise<{ build?: string | number | null }>;
}

let build: string | null = null;

/** Resolves once the build number is read (null in Jest, a dev client without Sentry's module, or on failure). */
export const nativeBuildReady: Promise<string | null> = (async () => {
  try {
    const release = await TurboModuleRegistry.get<RNSentry>("RNSentry")?.fetchNativeRelease();
    const value = String(release?.build ?? "").trim();
    build = value && value !== "0" ? value : null;
  } catch {
    // No module or no answer: the build stays unknown.
  }
  return build;
})();

/**
 * The build number, or null until `nativeBuildReady` settles (a few ms after launch) or when it can't be read. The
 * screens that show it open long after it is known.
 */
export const nativeBuild = (): string | null => build;
