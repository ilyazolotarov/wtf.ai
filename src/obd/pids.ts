// Mode 01 PID decoders. SI units (SPEC §6); RPM is the named-unit exception.

export const PID_SUPPORTED_01_20 = 0x00;
export const PID_RPM = 0x0c;
export const PID_SPEED = 0x0d;

export const PID_BYTES: Record<number, number> = {
  [PID_SUPPORTED_01_20]: 4,
  0x20: 4,
  0x40: 4,
  [PID_RPM]: 2,
  [PID_SPEED]: 1,
};

export const KMH_TO_MPS = 1 / 3.6;

export function decodeSpeedMps(bytes: number[]): number {
  return bytes[0] * KMH_TO_MPS;
}

export function decodeRpm(bytes: number[]): number {
  return (bytes[0] * 256 + bytes[1]) / 4;
}

/** Supported-PID bitmap (`0100`, `0120`, …) → hex PIDs, e.g. ["01", "0C", "0D", "20"]. */
export function decodeSupportedPids(base: number, bytes: number[]): string[] {
  const pids: string[] = [];
  for (let i = 0; i < 32; i++) {
    const byte = bytes[i >> 3] ?? 0;
    if (byte & (0x80 >> (i & 7))) {
      pids.push((base + i + 1).toString(16).toUpperCase().padStart(2, "0"));
    }
  }
  return pids;
}

export function decodePid(pid: number, bytes: number[]): number {
  if (pid === PID_SPEED) return decodeSpeedMps(bytes);
  if (pid === PID_RPM) return decodeRpm(bytes);
  return NaN;
}
