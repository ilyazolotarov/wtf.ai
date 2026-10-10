import Constants from "expo-constants";

/**
 * This project's servers, as app.config.js resolved them from the environment (UPDATES_ORIGIN, TRIP_UPLOAD_ORIGIN,
 * MAP_RELEASES_REPO): the source names none, so a fork needs no code change. Null: that feature is off. In an OTA
 * update `Constants.expoConfig` is the config the update was exported with.
 */
interface ServersConfig {
  updatesOrigin?: string | null;
  tripUploadUrl?: string | null;
  mapReleasesRepo?: string | null;
}

const extra = (Constants.expoConfig?.extra ?? {}) as ServersConfig;

/** The update Worker (workers/app-updates, docs/OTA.md): JS updates, native builds, the AltStore source, offline maps. */
export const UPDATES_ORIGIN: string | null = extra.updatesOrigin ?? null;

/** Our AltStore source (docs/UPDATES-SPEC.md §3). */
export const ALTSTORE_SOURCE_URL: string | null = UPDATES_ORIGIN && `${UPDATES_ORIGIN}/altstore.json`;

/** `owner/repo` whose GitHub releases `maps-*` hold maps for JS older than the Worker's (docs/UPDATES-SPEC.md §4). */
export const MAP_RELEASES_REPO: string | null = extra.mapReleasesRepo ?? null;

/** The trip log upload Worker (TRIP-LOGGER-SPEC §7.1). */
export const TRIP_UPLOAD_ORIGIN: string | null = extra.tripUploadUrl ?? null;
