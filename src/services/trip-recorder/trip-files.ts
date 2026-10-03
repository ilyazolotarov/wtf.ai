import { Directory, File, FileMode, Paths } from "expo-file-system";

import type { ByteSink } from "@/triplog/trip-log-writer";

export interface TripFileInfo {
  name: string;
  uri: string;
  size: number;
}

export interface TripFiles {
  create(name: string): ByteSink & { uri: string };
  list(): TripFileInfo[];
  remove(name: string): void;
  uri(name: string): string;
  freeBytes(): number;
}

/** Documents/trips/*.ulg (visible in the Files app with enableFileSharing). */
export function createTripFiles(): TripFiles {
  const dir = new Directory(Paths.document, "trips");
  const ensureDir = () => {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  };
  return {
    create(name) {
      ensureDir();
      const file = new File(dir, name);
      if (!file.exists) file.create();
      const handle = file.open(FileMode.Append);
      return {
        uri: file.uri,
        write: (bytes) => handle.writeBytes(bytes),
        close: () => handle.close(),
      };
    },
    list() {
      ensureDir();
      return dir
        .list()
        .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(".ulg"))
        .map((file) => ({ name: file.name, uri: file.uri, size: file.size ?? 0 }));
    },
    remove(name) {
      const file = new File(dir, name);
      if (file.exists) file.delete();
    },
    uri(name) {
      return new File(dir, name).uri;
    },
    freeBytes() {
      return Paths.availableDiskSpace;
    },
  };
}
