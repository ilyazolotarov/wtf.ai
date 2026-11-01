import { NativeModule, requireOptionalNativeModule } from "expo";

// Typed binding for modules/graph-bytes (iOS and Android): file reads for the navigator's worker runtime.

/** Random access reads of a file, on any runtime (cpp/GraphBytes.h). */
export interface GraphBytes {
  /** A handle on the file at this path (not a URI); throws when it can't be opened. */
  open(path: string): number;
  size(handle: number): number;
  /** `length` bytes from `offset`, fewer only at the end of the file. */
  read(handle: number, offset: number, length: number): ArrayBuffer;
  close(handle: number): void;
}

declare class GraphBytesModule extends NativeModule {
  install(): boolean;
}

const native = requireOptionalNativeModule<GraphBytesModule>("GraphBytes");

/** The reader on this (React Native) runtime, installed on first use; null without the module (an older build). */
export function installGraphBytes(): GraphBytes | null {
  const g = globalThis as { __wtfGraphBytes?: GraphBytes };
  if (!g.__wtfGraphBytes && native) native.install();
  return g.__wtfGraphBytes ?? null;
}
