import app from "../../../app.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require("../../../app.config.js") as (ctx: { config: typeof app.expo }) => Record<string, unknown> & {
  updates: { url?: string; enabled?: boolean; codeSigningCertificate?: string };
  extra: Record<string, unknown>;
};

const NAMES = [
  "UPDATES_ORIGIN",
  "TRIP_UPLOAD_ORIGIN",
  "GITHUB_REPOSITORY",
  "SENTRY_DSN",
  "PRIVACY_POLICY_URL",
  "DISTRIBUTION",
  "SUPPORT_EMAIL",
];
const INSTALL_PACKAGES = "android.permission.REQUEST_INSTALL_PACKAGES";
type Android = { permissions?: string[]; blockedPermissions?: string[] };
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
// Each test sets what it needs: CI's own repository variables must not leak in.
beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("app.config.js", () => {
  test("names no server or account itself: without the environment, updates, uploads and crash reports are off", () => {
    for (const n of NAMES) delete process.env[n];
    expect(JSON.stringify(app)).not.toMatch(/https?:\/\//);
    const config = appConfig({ config: app.expo });
    expect(config.updates).toMatchObject({ enabled: false, codeSigningCertificate: "./certs/certificate.pem" });
    expect(config.updates.url).toBeUndefined();
    expect(config.extra).toMatchObject({
      updatesOrigin: null,
      tripUploadUrl: null,
      sentryDsn: null,
      privacyPolicyUrl: null,
      distribution: "sideload",
    });
  });

  test("takes the servers from the environment", () => {
    process.env.UPDATES_ORIGIN = "https://updates.example/";
    process.env.TRIP_UPLOAD_ORIGIN = "https://logs.example";
    process.env.GITHUB_REPOSITORY = "someone/fork";
    const config = appConfig({ config: app.expo });
    expect(config.updates.url).toBe("https://updates.example/manifest");
    expect(config.updates.enabled).toBeUndefined();
    expect(config.extra).toMatchObject({
      updatesOrigin: "https://updates.example",
      tripUploadUrl: "https://logs.example",
      privacyPolicyUrl: "https://someone.github.io/fork/privacy.html",
    });
  });

  test("the privacy policy: the variable, else the CI repo's website", () => {
    process.env.GITHUB_REPOSITORY = "someone/fork";
    expect(appConfig({ config: app.expo }).extra.privacyPolicyUrl).toBe("https://someone.github.io/fork/privacy.html");
    process.env.PRIVACY_POLICY_URL = "https://example.org/privacy/";
    expect(appConfig({ config: app.expo }).extra.privacyPolicyUrl).toBe("https://example.org/privacy");
  });

  test("the sideloaded build installs its own updates and keeps the tester upload", () => {
    process.env.TRIP_UPLOAD_ORIGIN = "https://logs.example";
    const config = appConfig({ config: app.expo });
    expect((config.android as Android).permissions).toContain(INSTALL_PACKAGES);
    expect(config.extra).toMatchObject({ distribution: "sideload", tripUploadUrl: "https://logs.example" });
  });

  test("a store build cannot install packages and keeps the tester upload, behind the Developer unlock (docs/SPEC.md §2.2)", () => {
    process.env.DISTRIBUTION = "store";
    process.env.TRIP_UPLOAD_ORIGIN = "https://logs.example";
    const config = appConfig({ config: app.expo });
    const android = config.android as Android;
    expect(android.permissions).not.toContain(INSTALL_PACKAGES);
    expect(android.blockedPermissions).toEqual(
      expect.arrayContaining([INSTALL_PACKAGES, "android.permission.SYSTEM_ALERT_WINDOW", "android.permission.ACTIVITY_RECOGNITION"]),
    );
    expect(android.permissions).toContain("android.permission.ACCESS_FINE_LOCATION");
    expect(config.extra).toMatchObject({ distribution: "store", tripUploadUrl: "https://logs.example" });
  });
});

describe("app.json for review", () => {
  const plugins = app.expo.plugins as (string | [string, Record<string, unknown>])[];
  const options = (name: string) => (plugins.find((p) => Array.isArray(p) && p[0] === name) as [string, Record<string, unknown>])?.[1];

  test("no library's generic purpose string reaches the build (App Review 5.1.1)", () => {
    expect(options("expo-location")).toMatchObject({
      locationAlwaysAndWhenInUsePermission: expect.any(String),
      locationAlwaysPermission: expect.any(String),
      motionUsagePermission: expect.any(String),
    });
    expect(options("expo-sensors")).toMatchObject({ motionPermission: expect.any(String) });
    expect(options("expo-audio")).toMatchObject({ microphonePermission: expect.any(String) });
    expect(options("expo-secure-store")).toMatchObject({ faceIDPermission: false });
  });

  test("every localized Info.plist string exists in every language", () => {
    const en = Object.keys(require("../../../locales/en.json")).sort();
    const uk = Object.keys(require("../../../locales/uk.json")).sort();
    expect(uk).toEqual(en);
  });

  test("the privacy manifest declares no tracking and covers our own systemUptime", () => {
    const manifest = app.expo.ios.privacyManifests;
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyAccessedAPITypes).toContainEqual({
      NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
      NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
    });
  });
});
