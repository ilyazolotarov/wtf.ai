import { Directory, File, FileMode, Paths } from "expo-file-system";

import type { ByteSink } from "@/triplog/trip-log-writer";
import { ZipWriter } from "@/triplog/zip-writer";

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
  /** Stores the named trip files in one ZIP under Caches/trip-archives; returns its URI. */
  archive(archiveName: string, entries: { name: string; modified: Date }[]): string;
  freeBytes(): number;
}

/** Documents/trips/*.ulg (visible in the Files app with enableFileSharing). */
const ARCHIVE_CHUNK = 1 << 20;

function* readChunks(file: File): Generator<Uint8Array> {
  const handle = file.open(FileMode.ReadOnly);
  try {
    for (;;) {
      const chunk = handle.readBytes(ARCHIVE_CHUNK);
      if (chunk.length === 0) return;
      yield chunk;
    }
  } finally {
    handle.close();
  }
}

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
    archive(archiveName, entries) {
      // Only the latest archive is kept: the share sheet has copied the previous one.
      const archives = new Directory(Paths.cache, "trip-archives");
      if (archives.exists) archives.delete();
      archives.create({ intermediates: true });
      const out = new File(archives, archiveName);
      out.create();
      const handle = out.open(FileMode.Truncate);
      const zip = new ZipWriter({ write: (bytes) => handle.writeBytes(bytes), close: () => handle.close() });
      try {
        for (const e of entries) {
          const file = new File(dir, e.name);
          if (file.exists) zip.addFile(e.name, e.modified, readChunks(file));
        }
        zip.finish();
      } catch (err) {
        handle.close();
        out.delete();
        throw err;
      }
      return out.uri;
    },
    freeBytes() {
      return Paths.availableDiskSpace;
    },
  };
}
