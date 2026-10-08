/**
 * The trip log upload Worker (workers/triplog-upload, TRIP-LOGGER-SPEC §7.1). Not a secret: a code is needed to
 * upload, and nothing can be read through it. Empty: upload hidden in Settings.
 */
export const TRIP_UPLOAD_URL = "https://wtf-triplog-upload.ilyazolotarov.workers.dev";
