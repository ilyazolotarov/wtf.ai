import type { IconName } from "@/components/ui/icon";
import { usePalette, type StatusColor } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import type { TrustState } from "@/nav/position/types";
import { usePosition } from "@/providers/position-provider";
import { useVehicleLinkValue } from "@/providers/runtime-provider";

export type AdapterStatus = "on" | "searching" | "off";

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
  const trust: TrustState = position?.trust ?? "NO_FIX";
  // Wi-Fi/cell fixes (no speed) never earn trust, but the position is still a real, if coarse, one.
  const approximate =
    trust === "NO_FIX" &&
    position?.source === "gnss" &&
    position.speedMps === undefined;
  const meta = approximate ? APPROX : TRUST[trust];
  const color: StatusColor = palette[meta.color];
  const source =
    trust === "TRUSTED"
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
