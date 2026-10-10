// Is the network one to download updates on (docs/UPDATES-SPEC.md §5.1)? Wi-Fi or Ethernet that the OS doesn't call
// expensive: a phone's hotspot is Wi-Fi to us, but iOS and Android both flag it as metered.
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";

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
