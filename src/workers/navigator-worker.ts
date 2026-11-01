// The navigator's worker runtime (NAVIGATOR-SPEC §9): the same src/nav the replay runs, off the JS thread. Worklets
// import relatively here: the files generated for them resolve no `@/`.
import { createWorkletRuntime, scheduleOnRN, scheduleOnRuntime } from "react-native-worklets";

import { NavigatorRemote, type FileBytes, type FromRemote, type ToRemote } from "../services/navigation/navigator-remote";
import type { RemoteLink } from "../services/navigation/worker-navigator-host";

declare global {
  // The worker's NavigatorRemote, on its runtime only.
  var __navRemote: NavigatorRemote | undefined;
}

function receive(m: ToRemote): void {
  "worklet";
  globalThis.__navRemote!.receive(m);
}

/** A new worker running a navigator, and the link to it; `bytes` (modules/graph-bytes) reads its road graph there. */
export function startNavigatorWorker(bytes: FileBytes): RemoteLink {
  const listeners: ((m: FromRemote) => void)[] = [];
  const deliver = (m: FromRemote) => {
    for (const listener of listeners) listener(m);
  };
  const rt = createWorkletRuntime({ name: "nav", enableEventLoop: true, enableNetworking: false });
  scheduleOnRuntime(rt, () => {
    "worklet";
    globalThis.__navRemote = new NavigatorRemote({ bytes, reply: (m) => scheduleOnRN(deliver, m) });
  });
  return {
    post: (m) => scheduleOnRuntime(rt, receive, m),
    onReply: (listener) => listeners.push(listener),
  };
}
