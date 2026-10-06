import type { KeyValueStore } from "@/obd/vehicle-link-core";
import { MAX_RECENT, PlacesStore, type Place } from "@/services/navigation/places-store";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getJson: <T,>(key: string) => (data.has(key) ? (JSON.parse(data.get(key)!) as T) : null),
    setJson: (key: string, value: unknown) => void data.set(key, JSON.stringify(value)),
  };
}

const place = (id: string, lat: number, lon = 31.29, title = id): Place => ({ id, title, detail: null, lat, lon });
const A = place("a", 51.49);
const B = place("b", 51.5);

describe("PlacesStore", () => {
  it("keeps recent destinations newest first, once each, at most MAX_RECENT", () => {
    let t = 0;
    const store = new PlacesStore(memoryStore(), () => ++t);
    store.addRecent(A);
    store.addRecent(B);
    store.addRecent({ ...A, id: "a-again", lat: A.lat + 0.0001 }); // 11 m away: the same place
    expect(store.getSnapshot().recent.map((r) => r.id)).toEqual(["a-again", "b"]);
    for (let i = 0; i < 20; i++) store.addRecent(place(`p${i}`, 50 + i * 0.01));
    expect(store.getSnapshot().recent).toHaveLength(MAX_RECENT);
    expect(store.getSnapshot().recent[0].id).toBe("p19");
  });

  it("has one Home and one Work, any number of favourites, a place under one kind", () => {
    const store = new PlacesStore(memoryStore());
    store.save(A, "home");
    store.save(B, "home"); // moved house
    expect(store.getSnapshot().saved.map((s) => [s.id, s.kind])).toEqual([["b", "home"]]);
    store.save(A, "work");
    store.save(place("c", 51.6, 31.29, "Café"), "favorite");
    store.save(place("d", 51.7, 31.29, "Bakery"), "favorite");
    expect(store.getSnapshot().saved.map((s) => s.kind + ":" + s.id)).toEqual(["home:b", "work:a", "favorite:d", "favorite:c"]);
    store.save(B, "favorite"); // Home becomes a favourite
    expect(store.savedAt(B)?.kind).toBe("favorite");
    expect(store.getSnapshot().saved.filter((s) => s.kind === "home")).toEqual([]);
    store.unsave(B);
    expect(store.savedAt(B)).toBeNull();
  });

  it("survives a restart and tells listeners", () => {
    const kv = memoryStore();
    const store = new PlacesStore(kv);
    const listener = jest.fn();
    store.subscribe(listener);
    store.save(A, "work");
    store.addRecent(B);
    expect(listener).toHaveBeenCalledTimes(2);
    const again = new PlacesStore(kv);
    expect(again.getSnapshot().saved[0]).toMatchObject({ id: "a", kind: "work" });
    expect(again.getSnapshot().recent[0]).toMatchObject({ id: "b" });
    again.clearRecent();
    expect(new PlacesStore(kv).getSnapshot().recent).toEqual([]);
  });

  it("undoes a save that replaced Home", () => {
    const store = new PlacesStore(memoryStore());
    store.save(A, "home");
    const before = store.getSnapshot().saved;
    store.save(B, "home");
    store.restoreSaved(before);
    expect(store.getSnapshot().saved.map((s) => [s.id, s.kind])).toEqual([["a", "home"]]);
    expect(store.savedAt(B)).toBeNull();
  });
});
