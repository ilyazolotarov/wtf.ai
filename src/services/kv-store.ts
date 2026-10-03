import Storage from "expo-sqlite/kv-store";

import type { KeyValueStore } from "@/obd/vehicle-link-core";

/** JSON values in expo-sqlite kv-store (synchronous API). */
export const kvStore: KeyValueStore = {
  getJson<T>(key: string): T | null {
    try {
      const raw = Storage.getItemSync(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  setJson(key: string, value: unknown): void {
    Storage.setItemSync(key, JSON.stringify(value));
  },
};
