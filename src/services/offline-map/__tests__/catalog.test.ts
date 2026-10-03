import { assetUrl, fetchCatalog, MAP_RELEASES_REPO } from "@/services/offline-map/catalog";

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
  it("uses the newest maps-<date> release and ignores other tags", async () => {
    mockFetch({
      [releasesUrl]: [
        { tag_name: "map-chernihiv-2026-10-03" },
        { tag_name: "maps-2026-09-28" },
        { tag_name: "maps-2026-10-05" },
        { tag_name: "v1.0.0" },
      ],
      [`${download("maps-2026-10-05")}index.json`]: index,
    });
    const catalog = await fetchCatalog();
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
    await expect(fetchCatalog()).rejects.toThrow("No map release published yet");
    mockFetch({ "http://pc/index.json": { ...index, format: 1 } });
    await expect(fetchCatalog("http://pc")).rejects.toThrow("Unsupported map catalog format 1");
  });
});
