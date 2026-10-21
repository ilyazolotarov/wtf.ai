/**
 * The Bluetooth central's restoration id (VEHICLE-LINK-SPEC §11): with it iOS relaunches an app it ended when the
 * adapter's link has news. Every `initialize` passes it: the central is created once per process, by the first. The
 * Swift side has the same string (`LinkCore.restoreIdentifier`), for a central created at a restoration launch.
 */
export const RESTORE_IDENTIFIER = "ai.wtf.vehiclelink.central";
