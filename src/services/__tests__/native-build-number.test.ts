// The app's build number, read from Sentry's native module (docs/UPDATES-SPEC.md §3): without it no native update is
// ever offered.
type Module = { fetchNativeRelease: () => Promise<{ build?: string | number | null }> } | null;

/** Loads the helper afresh with `module` as what TurboModuleRegistry has under RNSentry. */
async function load(module: Module) {
  let helper!: typeof import("../native-build-number");
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TurboModuleRegistry } = require("react-native") as typeof import("react-native");
    jest.spyOn(TurboModuleRegistry, "get").mockImplementation((name) => (name === "RNSentry" ? module : null) as never);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    helper = require("../native-build-number");
  });
  const ready = await helper.nativeBuildReady;
  jest.restoreAllMocks();
  return { ready, now: helper.nativeBuild() };
}

describe("nativeBuild", () => {
  it("gives Android's versionCode as Sentry's module reads it", async () => {
    expect(await load({ fetchNativeRelease: async () => ({ build: "3583525" }) })).toEqual({ ready: "3583525", now: "3583525" });
  });

  it("takes a number too", async () => {
    expect((await load({ fetchNativeRelease: async () => ({ build: 3583525 }) })).now).toBe("3583525");
  });

  it("is unknown without the module, when it fails, or for build 0", async () => {
    expect((await load(null)).now).toBeNull();
    expect((await load({ fetchNativeRelease: () => Promise.reject(new Error("no")) })).now).toBeNull();
    expect((await load({ fetchNativeRelease: async () => ({ build: "0" }) })).now).toBeNull();
    expect((await load({ fetchNativeRelease: async () => ({}) })).now).toBeNull();
  });
});
