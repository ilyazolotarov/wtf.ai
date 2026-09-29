import type { PermissionResponse } from "expo-location";

import type { PositionEstimate } from "@/nav/position/types";

export interface PositionSource {
  start(): Promise<void>;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): PositionEstimate | null;
  getPermission(): Promise<PermissionResponse>;
  requestPermission(): Promise<PermissionResponse>;
}
