import app from "../../../app.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require("../../../app.config.js") as (ctx: { config: typeof app.expo }) => Record<string, unknown> & {
  updates: { url?: string; enabled?: boolean; codeSigningCertificate?: string };
  extra: Record<string, unknown>;
};

const NAMES = ["UPDATES_ORIGIN", "TRIP_UPLOAD_ORIGIN", "MAP_RELEASES_REPO", "GITHUB_REPOSITORY", "SENTRY_DSN"];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
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
    expect(config.extra).toMatchObject({ updatesOrigin: null, tripUploadUrl: null, mapReleasesRepo: null, sentryDsn: null });
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
      mapReleasesRepo: "someone/fork",
    });
    process.env.MAP_RELEASES_REPO = "someone/maps";
    expect(appConfig({ config: app.expo }).extra.mapReleasesRepo).toBe("someone/maps");
  });
});
