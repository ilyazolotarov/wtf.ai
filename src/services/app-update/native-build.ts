// Native builds (docs/UPDATES-SPEC.md §3): this app's build, the newest published one, and getting it installed:
// Android opens the downloaded APK in the system installer, iOS hands over to AltStore (or the share sheet).
import Constants from "expo-constants";
import { Directory, DownloadTask, File, Paths } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";
import * as Sharing from "expo-sharing";
import * as Updates from "expo-updates";
import { Linking, Platform } from "react-native";

import { ALTSTORE_SOURCE_URL, UPDATES_ORIGIN } from "@/config/app-updates";

import type { AppBuildInfo, OwnBuild } from "./decide";

/** Android's `Intent.FLAG_GRANT_READ_URI_PERMISSION`: the installer may read our file. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const APK_TYPE = "application/vnd.android.package-archive";

export const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";

export function ownBuild(): OwnBuild {
  const build = Number(Constants.nativeBuildVersion);
  return {
    build: Number.isSafeInteger(build) && build > 0 ? build : null,
    runtime: Updates.runtimeVersion ?? null,
    release: Updates.isEnabled,
  };
}

/**
 * The newest published build of this platform; null before the first, or when the build has no update server
 * (UPDATES_ORIGIN). Throws when the Worker can't be reached.
 */
export async function fetchLatestBuild(signal?: AbortSignal): Promise<AppBuildInfo | null> {
  if (!UPDATES_ORIGIN) return null;
  const res = await fetch(`${UPDATES_ORIGIN}/apps/${platform}/latest.json`, { signal, headers: { "cache-control": "no-cache" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Latest build: HTTP ${res.status}`);
  const build = (await res.json()) as AppBuildInfo;
  return Number.isSafeInteger(build.build) && typeof build.file === "string" ? build : null;
}

/** Only for a build `fetchLatestBuild` returned, so the update server is known. */
export const buildFileUrl = (build: AppBuildInfo) => `${UPDATES_ORIGIN}/apps/${build.platform}/${encodeURIComponent(build.file)}`;

const dir = () => new Directory(Paths.cache, "app-update");

/** The downloaded IPA/APK of `build`, if it is there and whole. */
export function downloadedFile(build: AppBuildInfo): File | null {
  const file = new File(dir(), build.file);
  return file.exists && file.size === build.size ? file : null;
}

/** Drops the IPA/APK downloads (at start: an update installed, or given up). */
export function clearDownloads(): void {
  try {
    if (dir().exists) dir().delete();
  } catch {
    // In use or gone: the next start tries again.
  }
}

/**
 * Downloads the IPA/APK and checks its size and MD5. `onProgress` gets the bytes so far. Resolves with the file, or null
 * when cancelled through `signal`.
 */
export async function downloadBuild(build: AppBuildInfo, onProgress: (bytes: number) => void, signal: AbortSignal): Promise<File | null> {
  const have = downloadedFile(build);
  if (have) return have;
  const folder = dir();
  folder.create({ intermediates: true, idempotent: true });
  const dest = new File(folder, build.file);
  if (dest.exists) dest.delete();
  const task = new DownloadTask(buildFileUrl(build), dest, { onProgress: ({ bytesWritten }) => onProgress(bytesWritten) });
  const abort = () => task.cancel();
  signal.addEventListener("abort", abort);
  try {
    const file = await task.downloadAsync();
    if (!file || signal.aborted) return null;
    const info = file.info({ md5: true });
    if (info.size !== build.size || info.md5 !== build.md5) {
      file.delete();
      throw new Error("The download is damaged: try again");
    }
    return file;
  } catch (e) {
    if (signal.aborted) return null;
    throw e;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Android: opens the system installer on the APK. The first time, Android asks to allow installs from wtf.ai. */
export async function installApk(file: File): Promise<void> {
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: file.contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
    type: APK_TYPE,
  });
}

/**
 * iOS: opens our source in AltStore, where the update is one tap (AltStore 2.2+ has `altstore-classic://`, older ones
 * `altstore://`). False when no AltStore takes it.
 */
export async function openAltStore(): Promise<boolean> {
  if (!ALTSTORE_SOURCE_URL) return false;
  const source = encodeURIComponent(ALTSTORE_SOURCE_URL);
  for (const url of [`altstore-classic://source?url=${source}`, `altstore://source?url=${source}`]) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // Not installed, or too old for this scheme: the next one.
    }
  }
  return false;
}

/** iOS without AltStore (SideStore, a PC): the IPA to the share sheet. */
export async function shareIpa(file: File): Promise<void> {
  await Sharing.shareAsync(file.uri, { UTI: "com.apple.itunes.ipa", mimeType: "application/octet-stream" });
}
