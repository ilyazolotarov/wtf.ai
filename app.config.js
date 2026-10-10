// This project's servers come from the environment, never from the source, so a fork builds against its own without
// code changes (docs/UPDATES-SPEC.md §2). In CI: repository variables of the same names; locally: .env.local, which
// Expo loads. Each is optional: without it, its feature is off.
//   UPDATES_ORIGIN       the update Worker (JS updates, builds, maps): updates.url. Unset: expo-updates off.
//   TRIP_UPLOAD_ORIGIN   the trip log upload Worker. Unset: no upload in the Trip recorder.
//   MAP_RELEASES_REPO    owner/repo with the `maps-*` GitHub releases; in CI, GITHUB_REPOSITORY.
//   SENTRY_DSN           where crash reports go (src/config/sentry.ts). Unset: no reports. The source map upload has its
//                        own: SENTRY_URL (the region), SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, read by sentry-cli.
// All are part of the OTA runtime version (fingerprint): every CI job that builds or exports sees the same values, and
// changing one needs a native build.
const env = (name) => process.env[name]?.trim().replace(/\/+$/, "") || null;

/** @param {{ config: import('expo/config').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const updatesOrigin = env("UPDATES_ORIGIN");
  return {
    ...config,
    updates: updatesOrigin ? { ...config.updates, url: `${updatesOrigin}/manifest` } : { ...config.updates, enabled: false },
    extra: {
      ...config.extra,
      updatesOrigin,
      tripUploadUrl: env("TRIP_UPLOAD_ORIGIN"),
      mapReleasesRepo: env("MAP_RELEASES_REPO") ?? env("GITHUB_REPOSITORY"),
      sentryDsn: env("SENTRY_DSN"),
    },
  };
};
