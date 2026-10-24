import { Asset } from "expo-asset";
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";

import type { MapStyleJson } from "@/config/map-dark";

import SPRITE from "./map-car-sprite.json";
import { MAP_CAR } from "./puck-style";

/*
 * The parked car's images (`MAP_CAR`) as a sprite of the map's style, referenced as `car:<name>`: the map loads them
 * with the style, before it lays the car out, on both platforms (images added from JS, `Images`, reach iOS only
 * through the map's missing-image request, after a first draw without them).
 *
 * The sheet (`scripts/map-car.py`: the 3x car and the near images, each with its pixel ratio) is a bundled asset; the map
 * reads a sprite as `<url>.json` and `<url>.png` (`@2x` on a dense screen) side by side, so it is copied once per
 * version into the documents folder with its index.
 */

const DIR = () => new Directory(Paths.document, "map-car", SPRITE.version);
const NAMES = ["car", "car@2x"];

/** The sprite's URL once its files are in place (a check of the disk, then remembered); `null` before. */
let url: string | null = null;
let installing: Promise<void> | null = null;
const listeners = new Set<() => void>();

function installed(): string | null {
  if (url) return url;
  const dir = DIR();
  if (NAMES.every((n) => new File(dir, `${n}.json`).exists && new File(dir, `${n}.png`).exists)) url = `${dir.uri.replace(/\/$/, "")}/car`;
  return url;
}

async function install(): Promise<void> {
  const { localUri } = await Asset.fromModule(require("@/assets/images/map-car-sprite.png")).downloadAsync();
  if (!localUri) throw new Error("the car sprite has no local file");
  const dir = DIR();
  // Earlier versions go.
  if (dir.parentDirectory.exists) for (const old of dir.parentDirectory.list()) if (old.name !== SPRITE.version) old.delete();
  dir.create({ intermediates: true, idempotent: true });
  for (const n of NAMES) {
    await new File(localUri).copy(new File(dir, `${n}.png`), { overwrite: true });
    // The index last: its presence says the sheet beside it is whole.
    new File(dir, `${n}.json`).write(JSON.stringify(SPRITE.images));
  }
  url = null;
  if (installed()) listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!installed() && !installing) {
    installing = install().catch((error) => {
      console.warn("Car sprite not installed", error);
      installing = null;
    });
  }
  return () => listeners.delete(listener);
}

/** The car sprite's URL, installing it on first use; `null` until its files are in place. */
export function useCarSprite(): string | null {
  return useSyncExternalStore(subscribe, installed);
}

/** The style with the car's sprite beside its own (the default, its images unprefixed). */
export function withCarSprite(style: MapStyleJson, spriteUrl: string | null): MapStyleJson {
  if (!spriteUrl) return style;
  const own = style.sprite;
  const sprites = typeof own === "string" ? [{ id: "default", url: own }] : Array.isArray(own) ? own : [];
  return { ...style, sprite: [...sprites, { id: MAP_CAR.sprite, url: spriteUrl }] };
}
