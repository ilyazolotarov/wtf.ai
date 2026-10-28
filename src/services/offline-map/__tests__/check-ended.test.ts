// A download whose check ended the app (an iPhone killed for memory checking the Ukraine map) waits for the driver at
// the next start instead of checking again by itself, and is reported once with the step it ended in.

const mockSaved = new Map<string, unknown>();
type MapPacks = typeof import("@/services/offline-map/map-packs");
/** The module as a new start of the app reads it. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const start = () => require("@/services/offline-map/map-packs") as MapPacks;

jest.mock("expo-file-system", () => {
  class Path {
    exists = false;
  }
  return { File: Path, Directory: Path, Paths: { document: "" } };
});
jest.mock("@/services/kv-store", () => ({
  kvStore: {
    getJson: (key: string) => (mockSaved.has(key) ? JSON.parse(JSON.stringify(mockSaved.get(key))) : null),
    setJson: (key: string, value: unknown) => mockSaved.set(key, value),
  },
}));

const job = (extra: object) => ({
  region: { region: "ukraine", asset: "ukraine.pmtiles", size: 1191755443, md5: "t", sha256: "" },
  osm_date: "2026-10-28",
  common: null,
  tiles: true,
  graph: true,
  search: true,
  files: [{ url: "u", dest: "ukraine.pmtiles.part", size: 1191755443, md5: "t", label: "ukraine.pmtiles" }],
  index: 1,
  done: 1191755443,
  total: 1191755443,
  ...extra,
});

beforeEach(() => {
  // An interrupted download's retry timer.
  jest.useFakeTimers();
  mockSaved.clear();
  jest.resetModules();
});

afterEach(() => jest.useRealTimers());

describe("a check that ended the app", () => {
  it("leaves the download paused for the driver, and is reported once with its step", () => {
    mockSaved.set("map-download-job", job({ checking: "ukraine.pmtiles" }));
    const packs = start();
    const report = jest.fn();
    packs.onMapDownloadFailed(report);

    expect(packs.getMapPacks().download).toEqual({
      region: "ukraine",
      phase: "paused",
      bytes: 1191755443,
      total: 1191755443,
      auto: false,
      checkEnded: true,
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toEqual({ region: "ukraine", file: "ukraine.pmtiles", index: 1, files: 1 });
    expect(mockSaved.get("map-download-job")).toMatchObject({ checkEnded: true, checking: undefined });

    // The next start: still waiting, nothing reported again.
    jest.resetModules();
    const again = start();
    const report2 = jest.fn();
    again.onMapDownloadFailed(report2);
    expect(again.getMapPacks().download).toMatchObject({ phase: "paused", checkEnded: true });
    expect(report2).not.toHaveBeenCalled();
  });

  it("does not touch a download stopped by a dropped connection", () => {
    mockSaved.set("map-download-job", job({}));
    const packs = start();
    const report = jest.fn();
    packs.onMapDownloadFailed(report);
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true });
    expect(packs.getMapPacks().download?.checkEnded).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });
});
