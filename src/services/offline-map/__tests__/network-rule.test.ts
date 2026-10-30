// Map downloads and the network (UPDATES-SPEC §5.2, map-packs `followNetwork`): an update stops off Wi-Fi and any
// download with no network, shown paused with Resume, and each goes on by itself once its network is back. iOS's
// background session waits without a network rather than failing: the download stood still with Pause showing.

const mockSaved = new Map<string, unknown>();
const mockAppListeners: ((state: string) => void)[] = [];
/** Every download task the module made, newest last. */
const mockTasks: { state: string; finish?: (file: unknown) => void }[] = [];
type MapPacks = typeof import("@/services/offline-map/map-packs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const start = () => require("@/services/offline-map/map-packs") as MapPacks;

jest.mock("expo-file-system", () => {
  class Path {
    exists = false;
    uri = "file:///x";
    parentDirectory = { create: () => {} };
    delete() {}
  }
  /** A task as expo-file-system's: the pending download resolves with null when paused. */
  class Task {
    state = "idle";
    finish?: (file: unknown) => void;
    constructor() {
      mockTasks.push(this);
    }
    static fromSavable() {
      return new Task();
    }
    run() {
      this.state = "active";
      return new Promise((resolve) => (this.finish = resolve));
    }
    downloadAsync() {
      return this.run();
    }
    resumeAsync() {
      return this.run();
    }
    pause() {
      this.state = "paused";
      this.finish?.(null);
    }
    savable() {
      return { url: "u", fileUri: "f", isDirectory: false };
    }
  }
  return { File: Path, Directory: Path, DownloadTask: Task, Paths: { document: "", cache: "" } };
});
jest.mock("@/services/kv-store", () => ({
  kvStore: {
    getJson: (key: string) => (mockSaved.has(key) ? JSON.parse(JSON.stringify(mockSaved.get(key))) : null),
    setJson: (key: string, value: unknown) => mockSaved.set(key, value),
  },
}));

/** A job stopped mid-way through its first big file (the app ended), as kept in kv-store. */
const job = (extra: object) => ({
  region: { region: "kyiv", asset: "kyiv.pmtiles", size: 40e6, md5: "t", sha256: "" },
  osm_date: "2026-10-28",
  common: null,
  tiles: true,
  graph: true,
  search: true,
  files: [
    { url: "u1", dest: "kyiv.pmtiles.part", size: 30e6, md5: "t", label: "kyiv.pmtiles" },
    { url: "u2", dest: "kyiv.graph.bin.part", size: 10e6, md5: "g", label: "kyiv.graph.bin" },
  ],
  index: 0,
  done: 0,
  total: 40e6,
  ...extra,
});

/** The network as NetInfo would tell it: `emit` a change heard, `set` one not heard (the app in the background). */
function network(initial: "unmetered" | "metered" | "none") {
  let now = initial;
  const listeners: ((n: typeof now) => void)[] = [];
  return {
    current: async () => now,
    subscribe: (listener: (n: typeof now) => void) => {
      listeners.push(listener);
      return () => {};
    },
    set: (n: typeof now) => void (now = n),
    emit: (n: typeof now) => {
      now = n;
      listeners.forEach((l) => l(n));
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockSaved.clear();
  mockAppListeners.length = 0;
  mockTasks.length = 0;
  jest.resetModules();
  // The app in front, and its state changes heard here: on the React Native the module is about to load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppState } = require("react-native") as typeof import("react-native");
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  AppState.addEventListener = ((_event: string, listener: (state: string) => void) => {
    mockAppListeners.push(listener);
    return { remove: () => {} };
  }) as typeof AppState.addEventListener;
});

afterEach(() => jest.useRealTimers());

describe("map downloads and the network", () => {
  it("an update waits for Wi-Fi, stops when the phone leaves it with Resume showing, and goes on back on it", async () => {
    mockSaved.set("map-download-job", job({ auto: true }));
    const packs = start();
    const net = network("metered");
    packs.setDownloadNetwork(net);
    await flush();
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true, wifi: true });
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(mockTasks).toHaveLength(0);

    net.emit("unmetered");
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
    expect(mockTasks.at(-1)?.state).toBe("active");

    net.emit("metered");
    await flush();
    expect(mockTasks.at(-1)?.state).toBe("paused");
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true, wifi: true });

    net.emit("unmetered");
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
  });

  it("an update the driver resumes on mobile data goes on there", async () => {
    mockSaved.set("map-download-job", job({ auto: true }));
    const packs = start();
    const net = network("metered");
    packs.setDownloadNetwork(net);
    await flush();
    void packs.resumeDownload();
    await flush();
    net.emit("metered");
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
    expect(mockTasks.at(-1)?.state).toBe("active");
  });

  it("with no network the driver's own download stops too, and goes on over any network once one is back", async () => {
    mockSaved.set("map-download-job", job({}));
    const packs = start();
    const net = network("none");
    packs.setDownloadNetwork(net);
    await flush();
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true });
    expect(packs.getMapPacks().download?.wifi).toBeUndefined();
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(mockTasks).toHaveLength(0);

    net.emit("metered");
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
    net.emit("none");
    await flush();
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true });
  });

  it("never undoes the driver's Pause", async () => {
    mockSaved.set("map-download-job", job({}));
    const packs = start();
    const net = network("unmetered");
    packs.setDownloadNetwork(net);
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
    packs.pauseDownload();
    await flush();
    net.emit("none");
    net.emit("unmetered");
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("paused");
    expect(packs.getMapPacks().download?.interrupted).toBeUndefined();
  });

  it("back in front, asks the network again: the phone left Wi-Fi in the background, unheard", async () => {
    mockSaved.set("map-download-job", job({ auto: true }));
    const packs = start();
    const net = network("unmetered");
    packs.setDownloadNetwork(net);
    await flush();
    expect(packs.getMapPacks().download?.phase).toBe("downloading");
    net.set("metered");
    mockAppListeners.forEach((l) => l("active"));
    await flush();
    expect(packs.getMapPacks().download).toMatchObject({ phase: "paused", interrupted: true, wifi: true });
  });
});
