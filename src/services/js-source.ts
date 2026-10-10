import * as Updates from "expo-updates";

/** Which JS the app runs (docs/OTA.md): the build's own, an OTA update, or `off` (Debug/dev client: Metro or embedded). */
export type JsSource = "embedded" | "update" | "off";

export function jsSource(): JsSource {
  if (!Updates.isEnabled) return "off";
  return Updates.isEmbeddedLaunch ? "embedded" : "update";
}

/** The commit the running JS was built from (inlined by Metro in CI), short. */
export const jsCommit = (): string | null => process.env.EXPO_PUBLIC_BUILD_SHA?.slice(0, 7) ?? null;

/**
 * Trip log info (TRIP-LOGGER-SPEC §6.2): the update a drive ran, so a log is matched to its JS even when the IPA is
 * older. `ver_update` is `embedded`, `off`, or the update id; `emergency` is added when a broken update made
 * expo-updates fall back to the embedded JS.
 */
export function jsSourceInfo(): { ver_update: string; ver_runtime: string } {
  const source = jsSource();
  const update = source === "update" ? (Updates.updateId ?? "unknown") : source;
  return {
    ver_update: Updates.isEmergencyLaunch ? `${update} emergency` : update,
    ver_runtime: Updates.runtimeVersion ?? "",
  };
}
