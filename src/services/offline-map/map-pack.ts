import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";

import type { MapStyleJson } from "@/config/map-dark";

/**
 * Offline map pack (SPEC §3.8): PMTiles, style, glyphs and sprites built by `tools/tiles`
 * (`tiles build-map`), described by `manifest.json`. A downloaded pack (`Documents/map/`)
 * wins over the one embedded in the app (`map-pack.bundle`, plugins/with-map-pack.js).
 */
export interface MapPackFile {
  path: string;
  size: number;
  sha256: string;
}

export interface MapPackManifest {
  format: number;
  region: string;
  version: string;
  osm_date: string;
  built_at: string;
  bounds: [number, number, number, number];
  total_size: number;
  files: MapPackFile[];
}

export interface ActiveMapPack {
  manifest: MapPackManifest;
  source: "downloaded" | "bundled";
  dir: Directory;
}

export interface InstallProgress {
  bytes: number;
  total: number;
}

const PACK_FORMAT = 1;
const PACK_DIR = "map";
const STAGING_DIR = "map.staging";
const BUNDLED_DIR = "map-pack.bundle";
const PLACEHOLDER = "{pack}";

const packDir = () => new Directory(Paths.document, PACK_DIR);

let active: ActiveMapPack | null | undefined;
const listeners = new Set<() => void>();

function readManifest(dir: Directory): MapPackManifest | null {
  try {
    const file = new File(dir, "manifest.json");
    if (!file.exists) return null;
    const manifest = JSON.parse(file.textSync()) as MapPackManifest;
    return manifest.format === PACK_FORMAT ? manifest : null;
  } catch {
    return null;
  }
}

function findPack(): ActiveMapPack | null {
  const downloaded = packDir();
  const manifest = readManifest(downloaded);
  if (manifest) return { manifest, source: "downloaded", dir: downloaded };
  const bundled = new Directory(Paths.bundle, BUNDLED_DIR);
  const bundledManifest = readManifest(bundled);
  return bundledManifest ? { manifest: bundledManifest, source: "bundled", dir: bundled } : null;
}

function refresh() {
  active = findPack();
  listeners.forEach((listener) => listener());
}

export function getActiveMapPack(): ActiveMapPack | null {
  if (active === undefined) active = findPack();
  return active;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveMapPack(): ActiveMapPack | null {
  return useSyncExternalStore(subscribe, getActiveMapPack);
}

/** The pack's style with `{pack}` resolved to the pack directory's file URL. */
export function readMapPackStyle(pack: ActiveMapPack): MapStyleJson {
  const raw = new File(pack.dir, "style.json").textSync();
  return JSON.parse(raw.replaceAll(PLACEHOLDER, pack.dir.uri.replace(/\/$/, ""))) as MapStyleJson;
}

/**
 * Downloads a pack served by `tiles serve` (dev) into a staging directory, checks
 * every file's size, then swaps it in. The current pack stays usable until the swap.
 */
export async function installMapPack(
  baseUrl: string,
  onProgress: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<MapPackManifest> {
  const base = baseUrl.trim().replace(/\/*$/, "/");
  const res = await fetch(`${base}manifest.json`, { signal });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  const manifest = (await res.json()) as MapPackManifest;
  if (manifest.format !== PACK_FORMAT) throw new Error(`Unsupported pack format ${manifest.format}`);

  const staging = new Directory(Paths.document, STAGING_DIR);
  if (staging.exists) staging.delete();
  staging.create({ intermediates: true });

  let done = 0;
  onProgress({ bytes: 0, total: manifest.total_size });
  for (const entry of manifest.files) {
    const dest = new File(staging, entry.path);
    dest.parentDirectory.create({ intermediates: true, idempotent: true });
    const url = base + entry.path.split("/").map(encodeURIComponent).join("/");
    await File.downloadFileAsync(url, dest, {
      idempotent: true,
      signal,
      onProgress: ({ bytesWritten }) =>
        onProgress({ bytes: done + bytesWritten, total: manifest.total_size }),
    });
    if (dest.size !== entry.size) {
      throw new Error(`${entry.path}: ${dest.size} bytes, expected ${entry.size}`);
    }
    done += entry.size;
    onProgress({ bytes: done, total: manifest.total_size });
  }
  // Written last: a staging dir without a manifest is never mistaken for a pack.
  new File(staging, "manifest.json").write(JSON.stringify(manifest));

  const current = packDir();
  if (current.exists) current.delete();
  staging.rename(PACK_DIR);
  refresh();
  return manifest;
}

/** Removes the downloaded pack; the bundled one (if any) takes over. */
export function removeMapPack(): void {
  const dir = packDir();
  if (dir.exists) dir.delete();
  refresh();
}
