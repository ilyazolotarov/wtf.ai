// This project's servers come from the environment, never from the source, so a fork builds against its own without
// code changes (docs/UPDATES-SPEC.md §2). In CI: repository variables of the same names; locally: .env.local, which
// Expo loads. Each is optional: without it, its feature is off.
//   UPDATES_ORIGIN       the update Worker (JS updates, builds, maps): updates.url. Unset: expo-updates off.
//   TRIP_UPLOAD_ORIGIN   the trip log upload Worker. Unset: no upload in the Trip recorder.
//   SENTRY_DSN           where crash reports go (src/config/sentry.ts). Unset: no reports. The source map upload has its
//                        own: SENTRY_URL (the region), SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, read by sentry-cli.
//   PRIVACY_POLICY_URL   the privacy policy Settings links to. Unset: the website's (GitHub Pages of GITHUB_REPOSITORY, set in
//                        CI; .github/workflows/pages.yml), which carries SUPPORT_EMAIL.
//   SUPPORT_EMAIL        where Settings › Contact support writes. Unset: no such row.
//   DISTRIBUTION         `store` for an App Store / Google Play build (docs/STORE-REVIEW.md): no self-installed
//                        updates (no REQUEST_INSTALL_PACKAGES, no APK installer, no AltStore), no tester trip upload, the
//                        Developer screen hidden until unlocked. Anything else, or unset: the sideloaded build.
// All are part of the OTA runtime version (fingerprint): every CI job that builds or exports sees the same values, and
// changing one needs a native build.
const env = (name) => process.env[name]?.trim().replace(/\/+$/, "") || null;

/** @param {{ config: import('expo/config').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const updatesOrigin = env("UPDATES_ORIGIN");
  const store = env("DISTRIBUTION") === "store";
  const repo = env("GITHUB_REPOSITORY");
  return {
    ...config,
    updates: updatesOrigin ? { ...config.updates, url: `${updatesOrigin}/manifest` } : { ...config.updates, enabled: false },
    // Google Play allows no app that installs its own updates (Device and Network Abuse policy).
    android: store ? storeAndroid(config.android) : config.android,
    extra: {
      ...config.extra,
      distribution: store ? "store" : "sideload",
      updatesOrigin,
      tripUploadUrl: store ? null : env("TRIP_UPLOAD_ORIGIN"),
      sentryDsn: env("SENTRY_DSN"),
      privacyPolicyUrl: env("PRIVACY_POLICY_URL") ?? (repo ? pagesUrl(repo, "privacy.html") : null),
      supportEmail: env("SUPPORT_EMAIL"),
    },
  };
};

const INSTALL_PACKAGES = "android.permission.REQUEST_INSTALL_PACKAGES";
// Added by libraries and the template, used by nothing in the app: Play reviews ask about each one. Overlays (dev
// client), step counting (expo-sensors' pedometer), biometrics (expo-secure-store; the app stores nothing behind them).
const UNUSED = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.ACTIVITY_RECOGNITION",
  "android.permission.USE_BIOMETRIC",
  "android.permission.USE_FINGERPRINT",
];

/** @param {import('expo/config').ExpoConfig['android']} android */
function storeAndroid(android = {}) {
  return {
    ...android,
    permissions: (android.permissions ?? []).filter((p) => p !== INSTALL_PACKAGES),
    // Also drops it when a library's manifest adds it.
    blockedPermissions: [...(android.blockedPermissions ?? []), INSTALL_PACKAGES, ...UNUSED],
  };
}

/** A page of `owner/repo`'s GitHub Pages site. */
function pagesUrl(repo, page) {
  const [owner, name] = repo.split("/");
  return `https://${owner.toLowerCase()}.github.io/${name}/${page}`;
}
