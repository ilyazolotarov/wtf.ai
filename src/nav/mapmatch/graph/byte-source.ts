/**
 * Random-access reads of a graph file (MAPMATCH-SPEC §5). Synchronous: tiles load on the JS
 * thread in well under a millisecond. Node: `fs.readSync` (tools/replay); device: an
 * expo-file-system FileHandle (src/services); tests: an in-memory buffer.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

export function bufferByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    read(offset, length) {
      if (offset < 0 || offset + length > bytes.byteLength) throw new RangeError(`read ${offset}+${length} past ${bytes.byteLength}`);
      return bytes.subarray(offset, offset + length);
    },
  };
}
