// The platform side of TripUploader: keychain, network type, file upload.
import { File, FileMode, Paths } from "expo-file-system";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";

import type { NetworkKind, TripUploaderDeps } from "./trip-uploader";

const CODE_KEY = "trip-upload-code";

export const uploadSecrets: TripUploaderDeps["secrets"] = {
  get: () => SecureStore.getItemAsync(CODE_KEY),
  // Readable after the first unlock: uploads may run while the phone is locked in its mount.
  set: (code) => SecureStore.setItemAsync(CODE_KEY, code, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  clear: () => SecureStore.deleteItemAsync(CODE_KEY),
};

export async function networkKind(): Promise<NetworkKind> {
  const state = await Network.getNetworkStateAsync();
  if (state.isConnected === false || state.type === Network.NetworkStateType.NONE) return "none";
  if (state.type === Network.NetworkStateType.WIFI || state.type === Network.NetworkStateType.ETHERNET) return "wifi";
  if (state.type === Network.NetworkStateType.CELLULAR) return "cellular";
  return "other";
}

export function onNetworkChange(listener: () => void): () => void {
  const subscription = Network.addNetworkStateListener(listener);
  return () => subscription.remove();
}

/** The raw file as the body (no multipart); on iOS the transfer can finish while the app is suspended. */
export async function putFile(url: string, fileUri: string, headers: Record<string, string>) {
  const res = await new File(fileUri).upload(url, { httpMethod: "PUT", headers });
  return { status: res.status, body: res.body };
}

/** Copied this much at a time into a part's file: the JS thread never holds a whole part (50 MB). */
const COPY_CHUNK = 1 << 20;

/**
 * Part of a file (a long log, sent in parts): copied into a file of its own in the cache, uploaded like a whole log,
 * then deleted.
 */
export async function putPart(url: string, fileUri: string, offset: number, length: number, headers: Record<string, string>) {
  const part = new File(Paths.cache, "trip-upload-part.bin");
  if (part.exists) part.delete();
  part.create();
  const from = new File(fileUri).open(FileMode.ReadOnly);
  const to = part.open(FileMode.Truncate);
  try {
    from.offset = offset;
    for (let left = length; left > 0; ) {
      const bytes = from.readBytes(Math.min(COPY_CHUNK, left));
      if (bytes.length === 0) throw new Error(`short read at ${offset + length - left} of ${fileUri}`);
      to.writeBytes(bytes);
      left -= bytes.length;
    }
  } finally {
    from.close();
    to.close();
  }
  try {
    return await putFile(url, part.uri, headers);
  } finally {
    part.delete();
  }
}

export const sizeOf = (fileUri: string) => new File(fileUri).size ?? 0;

export async function get(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}

export async function post(url: string, headers: Record<string, string>, body?: string) {
  const res = await fetch(url, { method: "POST", headers, body });
  return { status: res.status, body: await res.text() };
}
