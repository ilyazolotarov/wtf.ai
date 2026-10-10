import { TRIP_UPLOAD_ORIGIN } from "@/config/app-updates";

/**
 * The trip log upload Worker (workers/triplog-upload, TRIP-LOGGER-SPEC §7.1), from TRIP_UPLOAD_ORIGIN (app.config.js).
 * Not a secret: a code is needed to upload, and nothing can be read through it. Empty: upload hidden in Settings.
 */
export const TRIP_UPLOAD_URL: string = TRIP_UPLOAD_ORIGIN ?? "";
