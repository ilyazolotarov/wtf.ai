import { useEffect, useState } from "react";

import type { IconName } from "@/components/ui/icon";
import { usePalette, type StatusColor } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import type { PositionEstimate, TrustState } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import type { VehicleLinkSnapshot } from "@/obd/types";
import { useVehicleLinkValue } from "@/providers/runtime-provider";

export type AdapterStatus = "on" | "searching" | "off";

/**
 * The vehicle button's badge (UI-SPEC): ok = the car answers and is known (VIN read or remembered); busy =
 * connecting, searching the protocol, the car off or not answering yet, the VIN still being asked; bad = no adapter,
 * an error, a car whose VIN never came, or busy for longer than `BADGE_BUSY_MAX_MS` all together.
 */
export type LinkBadge = "ok" | "busy" | "bad";

/** Adapter, car and VIN together get this long before the badge says something is wrong. */
export const BADGE_BUSY_MAX_MS = 25_000;

function linkBadge(s: VehicleLinkSnapshot): LinkBadge {
  if (s.protocolSearch) return "busy";
  if (s.link === "polling") return s.vehicle?.vin ? "ok" : s.vehicle?.vinSource === "missing" ? "bad" : "busy";
  if (s.link === "idle" || s.link === "error") return "bad";
  return "busy";
}

export function useLinkBadge(): LinkBadge {
  const badge = useVehicleLinkValue(linkBadge);
  // Timed from when the link started trying (it spans auto-connect's turns, whose brief idles would restart a
  // timer kept here: the dot stayed yellow at home for minutes).
  const since = useVehicleLinkValue((s) => s.tryingSinceMs);
  const [expiredFor, setExpiredFor] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const timer = setTimeout(() => setExpiredFor(since), Math.max(0, since + BADGE_BUSY_MAX_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since]);
  return badge === "busy" && since !== null && expiredFor === since ? "bad" : badge;
}

const TRUST: Record<
  TrustState,
  { color: "ok" | "bad" | "warn" | "idle"; label: keyof Strings; sentence: keyof Strings; icon: IconName }
> = {
  TRUSTED: { color: "ok", label: "gpsOk", sentence: "sOk", icon: "satellite_alt" },
  UNTRUSTED: { color: "bad", label: "untrusted", sentence: "sUntrusted", icon: "gpp_maybe" },
  REACQUIRING: { color: "warn", label: "reacquiring", sentence: "sReacq", icon: "sync" },
  NO_FIX: { color: "idle", label: "noFix", sentence: "sNoFix", icon: "gps_off" },
};

const APPROX = { color: "warn", label: "approxFix", sentence: "sApprox", icon: "location_searching" } as const;

export function useAdapterStatus(): AdapterStatus {
  return useVehicleLinkValue((s) =>
    s.protocolSearch
      ? "searching"
      : s.link === "polling" || s.link === "standby"
      ? "on"
      : s.link === "connecting" ||
          s.link === "probing" ||
          s.link === "initializing" ||
          s.link === "reconnecting"
        ? "searching"
        : "off",
  );
}

/** Trust state, its colors and copy, and where the position comes from. */
export function useNavStatus() {
  const { t } = useT();
  const palette = usePalette();
  const position = usePosition();
  const adapter = useAdapterStatus();
  const protocolSearch = useVehicleLinkValue((s) => s.protocolSearch);
  return navStatusFrom(position, adapter, protocolSearch, palette, t);
}

/** `useNavStatus` for a given position and adapter state (the developer's UI gallery draws every state with it). */
export function navStatusFrom(
  position: PositionEstimate | null,
  adapter: AdapterStatus,
  protocolSearch: boolean,
  palette: ReturnType<typeof usePalette>,
  t: ReturnType<typeof useT>["t"],
) {
  const trust: TrustState = position?.trust ?? "NO_FIX";
  // Wi-Fi/cell fixes (no speed) never earn trust, but the position is still a real, if coarse, one.
  const approximate =
    trust === "NO_FIX" &&
    position?.source === "gnss" &&
    position.speedMps === undefined;
  const meta = approximate ? APPROX : TRUST[trust];
  const color: StatusColor = palette[meta.color];
  const source =
    position?.source === "manual"
      ? t("srcManual")
      : trust === "TRUSTED"
        ? t("srcGnss")
        : trust === "REACQUIRING"
          ? t("srcVerify")
          : adapter === "on"
            ? t("srcDR")
            : t("srcPhone");
  const adapterColor =
    adapter === "on" ? palette.ok : adapter === "searching" ? palette.warn : null;
  return {
    position,
    trust,
    approximate,
    color,
    icon: meta.icon,
    label: t(meta.label),
    sentence: t(meta.sentence),
    source,
    adapter,
    adapterColor: adapterColor?.c ?? palette.text2,
    adapterTint: adapterColor?.a ?? palette.surface,
    protocolSearch,
    adapterLabel: t(
      protocolSearch
        ? "obdFindingProtocol"
        : adapter === "on"
          ? "obdConnected"
          : adapter === "searching"
            ? "obdSearching"
            : "obdNotConnected",
    ),
  };
}
