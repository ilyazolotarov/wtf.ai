// Saved places (Home, Work, favourites) and recent destinations for the route screen
// (UI-SPEC §7.1), kept on the phone in kv-store.

import { haversineM, type Coordinate } from "@/nav/geo";
import type { KeyValueStore } from "@/obd/vehicle-link-core";

export type SavedKind = "home" | "work" | "favorite";

export interface Place extends Coordinate {
  /** The list entry it came from (`search:…`, a city id); new ids for the same spot are fine. */
  id: string;
  title: string;
  /** What and where it is ("Street · Chernihiv"), as shown when it was picked. */
  detail: string | null;
}

export interface SavedPlace extends Place {
  kind: SavedKind;
  savedAt: number;
}

export interface RecentPlace extends Place {
  usedAt: number;
}

export interface PlacesSnapshot {
  saved: SavedPlace[];
  recent: RecentPlace[];
}

const SAVED_KEY = "places.saved";
const RECENT_KEY = "places.recent";
export const MAX_RECENT = 10;
/** A destination this close to another one is the same place (a newer pick replaces it). */
const SAME_PLACE_M = 30;
const KIND_ORDER: Record<SavedKind, number> = { home: 0, work: 1, favorite: 2 };

const samePlace = (a: Place, b: Place) => a.id === b.id || haversineM(a, b) < SAME_PLACE_M;

export class PlacesStore {
  private snapshot: PlacesSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = {
      saved: store.getJson<SavedPlace[]>(SAVED_KEY) ?? [],
      recent: store.getJson<RecentPlace[]>(RECENT_KEY) ?? [],
    };
  }

  getSnapshot = (): PlacesSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A destination routed to: first in the recent list, once. */
  addRecent(place: Place): void {
    const entry: RecentPlace = { ...pick(place), usedAt: this.now() };
    const recent = [entry, ...this.snapshot.recent.filter((r) => !samePlace(r, place))].slice(0, MAX_RECENT);
    this.set({ recent });
  }

  removeRecent(id: string): void {
    this.set({ recent: this.snapshot.recent.filter((r) => r.id !== id) });
  }

  clearRecent(): void {
    this.set({ recent: [] });
  }

  /** Home and Work are one each: setting one replaces the old. A place is saved under one kind. */
  save(place: Place, kind: SavedKind): void {
    const entry: SavedPlace = { ...pick(place), kind, savedAt: this.now() };
    const saved = this.snapshot.saved.filter((s) => !samePlace(s, place) && (kind === "favorite" || s.kind !== kind));
    this.set({ saved: sortSaved([...saved, entry]) });
  }

  /** The saved entry for this place, if any. */
  savedAt(place: Place): SavedPlace | null {
    return this.snapshot.saved.find((s) => samePlace(s, place)) ?? null;
  }

  unsave(place: Place): void {
    this.set({ saved: this.snapshot.saved.filter((s) => !samePlace(s, place)) });
  }

  private set(patch: Partial<PlacesSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.saved) this.store.setJson(SAVED_KEY, this.snapshot.saved);
    if (patch.recent) this.store.setJson(RECENT_KEY, this.snapshot.recent);
    this.listeners.forEach((listener) => listener());
  }
}

const pick = ({ id, title, detail, lat, lon }: Place): Place => ({ id, title, detail, lat, lon });

const sortSaved = (saved: SavedPlace[]) =>
  saved.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title));
