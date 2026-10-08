// The platform side of TripUploader: keychain, network type, file upload.
import { File } from "expo-file-system";
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

export async function get(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}
