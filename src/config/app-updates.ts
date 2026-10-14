import { STORE_BUILD } from "./distribution";
import { extraString } from "./extra";

/**
 * This project's servers, as app.config.js resolved them from the environment (UPDATES_ORIGIN, TRIP_UPLOAD_ORIGIN):
 * the source names none, so a fork needs no code change. Null: that feature is off. In an OTA
 * update `Constants.expoConfig` is the config the update was exported with.
 */

/** The update Worker (workers/app-updates, docs/OTA.md): JS updates, native builds, the AltStore source, offline maps. */
export const UPDATES_ORIGIN: string | null = extraString("updatesOrigin");

/** Our AltStore source (docs/UPDATES-SPEC.md §3); none in a store build, which the store updates. */
export const ALTSTORE_SOURCE_URL: string | null = STORE_BUILD ? null : UPDATES_ORIGIN && `${UPDATES_ORIGIN}/altstore.json`;

/** The trip log upload Worker (TRIP-LOGGER-SPEC §7.1). */
export const TRIP_UPLOAD_ORIGIN: string | null = extraString("tripUploadUrl");
