// Adapter catalog: BLE GATT profiles, name patterns, ranking, UART selection.
// docs/VEHICLE-LINK-SPEC.md §3.2, §3.3, §7, §8.2. Adding a BLE adapter = edit this file (no native build).

import type {
  DeviceRank,
  GattProfile,
  GattServiceDump,
} from "./types";

/** Known serial-over-GATT layouts, in preference order. */
export const GATT_PROFILES: readonly GattProfile[] = [
  { id: "fff0", service: "FFF0", notify: "FFF1", write: "FFF2" },
  { id: "ffe0", service: "FFE0", notify: "FFE1", write: "FFE1" },
  { id: "vgate", service: "18F0", notify: "2AF0", write: "2AF1" },
  {
    id: "e781",
    service: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2",
    notify: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F",
    write: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F",
  },
  { id: "issc", service: "49535343-FE7D-4AE5-8FA9-9FAFD205E455" },
  {
    id: "nus",
    service: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
    notify: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E",
    write: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E",
  },
  { id: "beef", service: "BEEF" },
];

/** MFi protocol strings declared in Info.plist (VEHICLE-LINK-SPEC §3.4). */
export const MFI_PROTOCOLS: readonly string[] = ["com.obdlink", "com.vgatemall"];

export const MFI_BRANDS: Record<string, string> = {
  "com.obdlink": "OBDLink",
  "com.vgatemall": "Vgate",
};

interface NamePattern {
  pattern: RegExp;
  brand: string;
}

/** Brand patterns first; generic clone patterns last. */
export const NAME_PATTERNS: readonly NamePattern[] = [
  { pattern: /obdlink/i, brand: "OBDLink" },
  { pattern: /v-?link|vlinker|vgate|icar/i, brand: "Vgate" },
  { pattern: /veepeak|obdcheck/i, brand: "Veepeak" },
  { pattern: /lelink/i, brand: "LELink" },
  { pattern: /carista/i, brand: "Carista" },
  { pattern: /kiwi/i, brand: "PLX Kiwi" },
  { pattern: /konnwei|kw\d{3}/i, brand: "Konnwei" },
  { pattern: /viecar/i, brand: "Viecar" },
  { pattern: /fixd/i, brand: "FIXD" },
  { pattern: /unicarscan/i, brand: "UniCarScan" },
  { pattern: /yawoa/i, brand: "Yawoa" },
  { pattern: /tonwon/i, brand: "Tonwon" },
  { pattern: /cyel/i, brand: "CYEL" },
  { pattern: /microtech/i, brand: "MicroTech" },
  { pattern: /obd|elm|327/i, brand: "Generic ELM327" },
];

/** Known non-ELM devices: shown last with a warning. */
export const NON_ELM_PATTERNS: readonly NamePattern[] = [
  { pattern: /bluedriver/i, brand: "BlueDriver (proprietary, not ELM327)" },
  { pattern: /xtool/i, brand: "xTool (not ELM327)" },
];

/** Bluetooth SIG services that never carry the UART. */
const IGNORED_SERVICES = new Set(["1800", "1801", "180A", "180F", "FEF5"]);

/** Normalize to the short form for SIG base UUIDs, upper case otherwise. */
export function normalizeUuid(uuid: string): string {
  const u = uuid.trim().toUpperCase();
  const m = /^0000([0-9A-F]{4})-0000-1000-8000-00805F9B34FB$/.exec(u);
  return m ? m[1] : u;
}

/** Bluetooth SIG GATT services live in 0x1800–0x18FF (18F0 is Vgate's, not SIG). */
function isSigService(uuid: string): boolean {
  return /^18[0-9A-F]{2}$/.test(uuid) && uuid !== "18F0";
}

export function profileForService(serviceUuid: string): GattProfile | undefined {
  const u = normalizeUuid(serviceUuid);
  return GATT_PROFILES.find((p) => normalizeUuid(p.service) === u);
}

export interface RankInput {
  name: string | null;
  serviceUuids?: string[];
  remembered?: boolean;
}

export interface RankResult {
  rank: DeviceRank;
  brandHint?: string;
  profileId?: string;
}

export function rankDevice(input: RankInput): RankResult {
  const name = input.name ?? "";
  const profile = (input.serviceUuids ?? [])
    .map(profileForService)
    .find((p): p is GattProfile => p !== undefined);
  const nonElm = NON_ELM_PATTERNS.find((p) => p.pattern.test(name));
  const brand = NAME_PATTERNS.find((p) => p.pattern.test(name));

  if (input.remembered) {
    return { rank: "remembered", brandHint: brand?.brand, profileId: profile?.id };
  }
  if (nonElm) return { rank: "non-elm", brandHint: nonElm.brand };
  if (profile) return { rank: "known-profile", brandHint: brand?.brand, profileId: profile.id };
  if (brand) return { rank: "known-name", brandHint: brand.brand };
  return { rank: "unknown" };
}

const RANK_ORDER: Record<DeviceRank, number> = {
  remembered: 0,
  "known-profile": 1,
  "known-name": 2,
  unknown: 3,
  "non-elm": 4,
};

export function compareDevices(
  a: { rank: DeviceRank; rssi?: number; name: string | null },
  b: { rank: DeviceRank; rssi?: number; name: string | null },
): number {
  const byRank = RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  if (byRank !== 0) return byRank;
  const byRssi = (b.rssi ?? -999) - (a.rssi ?? -999);
  if (byRssi !== 0) return byRssi;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

export interface UartCandidate {
  profileId: string;
  service: string;
  notify: string;
  write: string;
}

const NOTIFY_PROPS = ["notify", "indicate"];
const WRITE_PROPS = ["write", "writeWithoutResponse"];

/**
 * Pick UART candidates from a GATT dump, best first (VEHICLE-LINK-SPEC §8.2):
 * catalog profiles in catalog order, then the heuristic (one notify + one write char).
 * Native does the same with the profile list; this is used for tests, diagnostics,
 * and to keep the rules in one readable place.
 */
export function selectUartCandidates(dump: GattServiceDump[]): UartCandidate[] {
  const result: UartCandidate[] = [];
  const services = dump.map((s) => ({
    uuid: normalizeUuid(s.uuid),
    chars: s.characteristics.map((c) => ({ uuid: normalizeUuid(c.uuid), props: c.properties })),
  }));

  for (const profile of GATT_PROFILES) {
    const service = services.find((s) => s.uuid === normalizeUuid(profile.service));
    if (!service) continue;
    const notify = profile.notify
      ? service.chars.find((c) => c.uuid === normalizeUuid(profile.notify!))
      : service.chars.find((c) => c.props.some((p) => NOTIFY_PROPS.includes(p)));
    const write = profile.write
      ? service.chars.find((c) => c.uuid === normalizeUuid(profile.write!))
      : service.chars.find((c) => c.props.some((p) => WRITE_PROPS.includes(p)));
    if (notify && write) {
      result.push({ profileId: profile.id, service: service.uuid, notify: notify.uuid, write: write.uuid });
    }
  }

  for (const service of services) {
    if (IGNORED_SERVICES.has(service.uuid) || isSigService(service.uuid)) continue;
    if (result.some((r) => r.service === service.uuid)) continue;
    const notifies = service.chars.filter((c) => c.props.some((p) => NOTIFY_PROPS.includes(p)));
    const writes = service.chars.filter((c) => c.props.some((p) => WRITE_PROPS.includes(p)));
    if (notifies.length === 1 && writes.length === 1) {
      result.push({
        profileId: "heuristic",
        service: service.uuid,
        notify: notifies[0].uuid,
        write: writes[0].uuid,
      });
    }
  }
  return result;
}
