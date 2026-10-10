import { assetUrl, CatalogFormatError, fetchCatalog } from "@/services/offline-map/catalog";

const UPDATES_ORIGIN = "https://updates.example";
const MAP_RELEASES_REPO = "someone/wtf.ai";
const SERVERS = { updatesOrigin: UPDATES_ORIGIN, releasesRepo: MAP_RELEASES_REPO };

const index = { format: 2, osm_date: "2026-10-03", built_at: "", common: [], regions: [] };

function mockFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url);
    const body = routes[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const releasesUrl = `https://api.github.com/repos/${MAP_RELEASES_REPO}/releases?per_page=30`;
const download = (tag: string) => `https://github.com/${MAP_RELEASES_REPO}/releases/download/${tag}/`;

describe("fetchCatalog", () => {
  it("reads the update Worker's current release", async () => {
    const calls = mockFetch({
      [`${UPDATES_ORIGIN}/maps/latest.json`]: { osm_date: "2026-10-03", published: "x" },
      [`${UPDATES_ORIGIN}/maps/2026-10-03/index.json`]: index,
    });
    const catalog = await fetchCatalog(undefined, undefined, SERVERS);
    expect(catalog.baseUrl).toBe(`${UPDATES_ORIGIN}/maps/2026-10-03/`);
    expect(calls).toHaveLength(2);
    expect(assetUrl(catalog, { asset: "sprite-ofm@2x.png", size: 1, md5: "", sha256: "" })).toBe(
      `${UPDATES_ORIGIN}/maps/2026-10-03/sprite-ofm%402x.png`,
    );
  });

  it("falls back to the newest maps-<date> GitHub release while the Worker has none, ignoring other tags", async () => {
    mockFetch({
      [releasesUrl]: [
        { tag_name: "map-chernihiv-2026-10-03" },
        { tag_name: "maps-2026-09-28" },
        { tag_name: "maps-2026-10-05" },
        { tag_name: "v1.0.0" },
      ],
      [`${download("maps-2026-10-05")}index.json`]: index,
    });
    const catalog = await fetchCatalog(undefined, undefined, SERVERS);
    expect(catalog.baseUrl).toBe(download("maps-2026-10-05"));
    expect(catalog.osm_date).toBe("2026-10-03");
  });

  it("reads a custom source without asking GitHub", async () => {
    const calls = mockFetch({ "http://192.168.1.10:8765/index.json": index });
    const catalog = await fetchCatalog(" http://192.168.1.10:8765 ");
    expect(calls).toEqual(["http://192.168.1.10:8765/index.json"]);
    expect(assetUrl(catalog, { asset: "kyiv-city.pmtiles", size: 1, md5: "", sha256: "" })).toBe(
      "http://192.168.1.10:8765/kyiv-city.pmtiles",
    );
  });

  it("fails clearly without a release or with an unknown format", async () => {
    mockFetch({ [releasesUrl]: [{ tag_name: "v1" }] });
    await expect(fetchCatalog(undefined, undefined, SERVERS)).rejects.toThrow("No map release published yet");
    mockFetch({ "http://pc/index.json": { ...index, format: 1 } });
    await expect(fetchCatalog("http://pc")).rejects.toThrow(CatalogFormatError);
    await expect(fetchCatalog(undefined, undefined, { updatesOrigin: null, releasesRepo: null })).rejects.toThrow("No map source");
  });
});
