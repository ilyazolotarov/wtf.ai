// The installed maps' speed cameras (UI-SPEC §6.5): the shared `cameras.json`, read once per map release.

import { CameraIndex, parseCameras } from "@/nav/speed/cameras";
import { activeCamerasFile, getMapPacks, type InstalledState } from "@/services/offline-map/map-packs";

let open: { key: string; index: CameraIndex } | null = null;
/** The release last looked at without cameras (none in it, or the file wouldn't read): not looked at again. */
let missingKey: string | null = null;

const releaseKey = (installed: InstalledState) => installed.common?.fingerprint ?? installed.common?.osm_date ?? null;

/**
 * The cameras, by place; null without them (maps from before cameras, none installed). Asked at every position: the
 * disk is read only when the shared files change. In a component, pass `useMapPacks().installed`.
 */
export function activeCameras(installed: InstalledState = getMapPacks().installed): { key: string; index: CameraIndex } | null {
  const key = releaseKey(installed);
  if (!key) return null;
  if (open?.key === key) return open;
  if (missingKey === key) return null;
  open = null;
  const found = activeCamerasFile(installed);
  if (!found) {
    missingKey = key;
    return null;
  }
  try {
    open = { key, index: new CameraIndex(parseCameras(found.file.textSync())) };
    missingKey = null;
    return open;
  } catch (e) {
    missingKey = key;
    console.warn(`speed cameras: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
