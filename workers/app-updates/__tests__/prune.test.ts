/**
 * @jest-environment node
 */
import { prune } from "../prune";
import { testBucket, type TestBucket } from "../test-bucket";

const HOUR = 3600 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z").getTime();

let bucket: TestBucket;
beforeEach(() => {
  bucket = testBucket();
});

/** Stores `key` as uploaded `hours` after T0. */
async function put(key: string, value: string | object = "x", hours = 0) {
  bucket.now = new Date(T0 + hours * HOUR);
  await bucket.put(key, typeof value === "string" ? value : JSON.stringify(value));
}
const run = (hours: number, dry = false) => prune({ BUCKET: bucket }, new Date(T0 + hours * HOUR), dry);
const keys = () => [...bucket.objects.keys()].sort();

const update = (runtime: string, platform: string, id: string, assets: string[]) => ({
  id,
  signature: "s",
  manifest: JSON.stringify({ id, runtimeVersion: runtime, launchAsset: { key: assets[0] }, assets: assets.slice(1).map((key) => ({ key })) }),
});

describe("prune", () => {
  it("keeps the newest 3 builds per platform and their files; strays go after a day", async () => {
    for (const build of [1, 2, 3, 4]) {
      await put(`apps/ios/${build}.json`, {}, build);
      await put(`apps/ios/wtfai-${build}.ipa`, "ipa", build);
    }
    await put("apps/ios/latest.json", {}, 4);
    await put("apps/ios/wtfai-9.ipa", "upload in progress", 30);
    await put("apps/ios/wtfai-8.ipa", "a publish that failed", 2);
    await run(31);
    expect(keys()).toEqual([
      "apps/ios/2.json",
      "apps/ios/3.json",
      "apps/ios/4.json",
      "apps/ios/latest.json",
      "apps/ios/wtfai-2.ipa",
      "apps/ios/wtfai-3.ipa",
      "apps/ios/wtfai-4.ipa",
      "apps/ios/wtfai-9.ipa",
    ]);
  });

  it("drops the JS of all but the newest 3 runtimes, all but each one's latest record, and files no kept record uses", async () => {
    // Runtimes r1…r4 for iOS, registered an hour apart; r1 is the oldest.
    for (const [i, r] of ["r1", "r2", "r3", "r4"].entries()) {
      await put(`builds/${r}/ios.json`, { commit: r }, i);
      const rec = update(r, "ios", `${r}-a`, [`${r}-bundle`, "shared-font"]);
      await put(`updates/${r}/ios/${r}-a.json`, rec, i);
      await put(`latest/${r}/ios.json`, rec, i);
      await put(`assets/${r}-bundle`, "js", i);
    }
    await put("assets/shared-font", "ttf", 0);
    // r4 got four updates: all but the latest go, with the bundles only they used.
    for (const [i, id] of ["r4-b", "r4-c", "r4-d"].entries()) {
      const rec = update("r4", "ios", id, [`${id}-bundle`]);
      await put(`updates/r4/ios/${id}.json`, rec, 10 + i);
      await put(`latest/r4/ios.json`, rec, 10 + i);
      await put(`assets/${id}-bundle`, "js", 10 + i);
    }
    // Uploaded for a publish still running: no record names it yet.
    await put("assets/in-flight", "js", 40);

    const removed = await run(48);
    expect(removed.sort()).toEqual([
      "assets/r1-bundle",
      "assets/r4-b-bundle",
      "assets/r4-bundle",
      "assets/r4-c-bundle",
      "builds/r1/ios.json",
      "latest/r1/ios.json",
      "updates/r1/ios/r1-a.json",
      "updates/r4/ios/r4-a.json",
      "updates/r4/ios/r4-b.json",
      "updates/r4/ios/r4-c.json",
    ]);
    expect(bucket.objects.has("assets/r4-d-bundle")).toBe(true);
    expect(bucket.objects.has("assets/shared-font")).toBe(true);
    expect(bucket.objects.has("assets/in-flight")).toBe(true);
  });

  it("keeps a runtime whose latest publish is recent even without a registered build", async () => {
    await put("latest/old/android.json", update("old", "android", "x", ["k"]), 0);
    await put("updates/old/android/x.json", update("old", "android", "x", ["k"]), 0);
    await put("assets/k", "js", 0);
    expect(await run(100)).toEqual([]);
  });

  it("keeps the current map release, the one before it for 2 days, and an upload on its way", async () => {
    for (const date of ["2026-09-24", "2026-10-01", "2026-10-08", "2026-10-15"]) await put(`maps/${date}/index.json`, {}, 0);
    await put("maps/2026-10-15/kyiv.pmtiles", "tiles", 70);
    await put("maps/latest.json", { osm_date: "2026-10-08", published: "x", previous: { osm_date: "2026-10-01", until: new Date(T0 + 48 * HOUR).toISOString() } });
    expect((await run(24, true)).sort()).toEqual(["maps/2026-09-24/index.json"]);
    expect(bucket.objects.has("maps/2026-09-24/index.json")).toBe(true);
    await run(72);
    expect(keys()).toEqual([
      "maps/2026-10-08/index.json",
      "maps/2026-10-15/index.json",
      "maps/2026-10-15/kyiv.pmtiles",
      "maps/latest.json",
    ]);
    // Abandoned: nothing uploaded to it for 2 days.
    await run(70 + 49);
    expect(keys()).toEqual(["maps/2026-10-08/index.json", "maps/latest.json"]);
  });

  it("leaves the maps alone before a release is published", async () => {
    await put("maps/2026-10-08/index.json", {}, 0);
    expect(await run(500)).toEqual([]);
  });
});
