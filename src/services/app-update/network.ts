// Is the network one to download updates on (docs/UPDATES-SPEC.md §5.1)? Wi-Fi or Ethernet that the OS doesn't call
// expensive: a phone's hotspot is Wi-Fi to us, but iOS and Android both flag it as metered.
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

import type { DownloadNetwork } from "@/services/offline-map/map-packs";

// NetInfo probes a Google URL to tell whether the internet is reachable; the app needs only the connection type, and
// contacts nothing but its own servers.
NetInfo.configure({ reachabilityShouldRun: () => false });

export function unmetered(state: NetInfoState): boolean {
  if (state.isConnected === false) return false;
  if (state.type !== "wifi" && state.type !== "ethernet") return false;
  return !state.details?.isConnectionExpensive;
}

export async function isUnmetered(): Promise<boolean> {
  return unmetered(await NetInfo.fetch());
}

export function onNetworkChange(listener: (unmetered: boolean) => void): () => void {
  return NetInfo.addEventListener((state) => listener(unmetered(state)));
}

/** The network as map downloads see it (map-packs `followNetwork`): unmetered, metered, or none at all. */
export function downloadNetwork(state: NetInfoState): DownloadNetwork {
  if (state.isConnected === false || state.type === "none") return "none";
  return unmetered(state) ? "unmetered" : "metered";
}

export async function currentDownloadNetwork(): Promise<DownloadNetwork> {
  return downloadNetwork(await NetInfo.fetch());
}

export function onDownloadNetwork(listener: (network: DownloadNetwork) => void): () => void {
  return NetInfo.addEventListener((state) => listener(downloadNetwork(state)));
}
