import { assetUrl, CatalogFormatError, fetchCatalog } from "@/services/offline-map/catalog";

const UPDATES_ORIGIN = "https://updates.example";

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

describe("fetchCatalog", () => {
  it("reads the update Worker's current release", async () => {
    const calls = mockFetch({
      [`${UPDATES_ORIGIN}/maps/latest.json`]: { osm_date: "2026-10-03", published: "x" },
      [`${UPDATES_ORIGIN}/maps/2026-10-03/index.json`]: index,
    });
    const catalog = await fetchCatalog(undefined, UPDATES_ORIGIN);
    expect(catalog.baseUrl).toBe(`${UPDATES_ORIGIN}/maps/2026-10-03/`);
    expect(calls).toHaveLength(2);
    expect(assetUrl(catalog, { asset: "sprite-ofm@2x.png", size: 1, md5: "", sha256: "" })).toBe(
      `${UPDATES_ORIGIN}/maps/2026-10-03/sprite-ofm%402x.png`,
    );
  });

  it("says when the Worker has no release yet", async () => {
    const calls = mockFetch({});
    await expect(fetchCatalog(undefined, UPDATES_ORIGIN)).rejects.toThrow("No map release published yet");
    expect(calls).toEqual([`${UPDATES_ORIGIN}/maps/latest.json`]);
  });

  it("fails clearly without a source or with an unknown format", async () => {
    mockFetch({
      [`${UPDATES_ORIGIN}/maps/latest.json`]: { osm_date: "2026-10-03" },
      [`${UPDATES_ORIGIN}/maps/2026-10-03/index.json`]: { ...index, format: 1 },
    });
    await expect(fetchCatalog(undefined, UPDATES_ORIGIN)).rejects.toThrow(CatalogFormatError);
    await expect(fetchCatalog(undefined, null)).rejects.toThrow("No map source");
  });
});
