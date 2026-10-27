import type { MapCatalog } from "@/services/offline-map/catalog";
import { commonFingerprint, installedRelease, releaseFingerprint, type InstalledState } from "@/services/offline-map/map-packs";

jest.mock("expo-file-system", () => ({}));
jest.mock("@/services/kv-store", () => ({ kvStore: { getJson: () => null, setJson: () => undefined } }));

const file = (md5: string) => ({ asset: "x", size: 1, md5, sha256: "" });
const catalog = (graph = "g1", search = "s1"): MapCatalog => ({
  format: 2,
  osm_date: "2026-10-26",
  built_at: "",
  baseUrl: "https://updates.example/maps/2026-10-26/",
  common: [{ ...file("c1"), path: "style.json" }],
  regions: [
    {
      ...file("t1"),
      region: "kyiv",
      iso: "UA-32",
      name: { en: "Kyiv Oblast", uk: "Київська область" },
      bounds: [29, 49, 32, 51],
      graph: file(graph),
      search: file(search),
    },
  ],
});

describe("releaseFingerprint", () => {
  it("is the region's files: the same for the same files, another when one changes under the same OSM date", () => {
    expect(releaseFingerprint(catalog(), "kyiv")).toMatch(/^[0-9a-f]{8}$/);
    expect(releaseFingerprint(catalog(), "kyiv")).toBe(releaseFingerprint(catalog(), "kyiv"));
    expect(releaseFingerprint(catalog("g1", "s2"), "kyiv")).not.toBe(releaseFingerprint(catalog(), "kyiv"));
    expect(releaseFingerprint(catalog(), "lviv")).toBeNull();
  });

  it("is what an install of those files records, so a remembered update ends with it", () => {
    const c = catalog();
    const entry = c.regions[0];
    const installed: InstalledState = {
      common: { osm_date: c.osm_date, fingerprint: commonFingerprint(c) },
      regions: { kyiv: { ...entry, osm_date: c.osm_date, graph: { size: 1, md5: "g1" }, search: { size: 1, md5: "s1" } } },
      active: "kyiv",
    };
    expect(installedRelease(installed, "kyiv")).toBe(releaseFingerprint(c, "kyiv"));
    expect(installedRelease(installed, "kyiv")).not.toBe(releaseFingerprint(catalog("g1", "s2"), "kyiv"));
    // Recorded before tiles had their MD5: never the release.
    const { md5: _md5, ...old } = installed.regions.kyiv;
    expect(installedRelease({ ...installed, regions: { kyiv: old } }, "kyiv")).not.toBe(releaseFingerprint(c, "kyiv"));
    expect(installedRelease(installed, "lviv")).toBeNull();
  });
});
