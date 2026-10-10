import { StyleSheet, View } from "react-native";

import { cardinal, formatDistance, toDegrees } from "@/components/status/format-geo";
import { formatDuration } from "@/components/status/format-time";
import { useAgeText } from "@/components/status/use-age-text";
import type { useNavStatus } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM } from "@/nav/geo";
import type { PositionEstimate, RawGnssFix, SimulatedOutage } from "@/nav/position/types";

import { CardButton, CardLine, HudCard, hud, usePanelStyle } from "./hud-card";

type NavStatus = ReturnType<typeof useNavStatus>;
type Translate = ReturnType<typeof useT>["t"];

/** Driven less than this since the last trusted fix, the strip gives only its age. */
const SINCE_TRUSTED_MIN_M = 50;

/** What the trust alert under the status pill says, or null when GPS is fine (or there is no position). */
export function trustAlertText(
  nav: Pick<NavStatus, "position" | "trust" | "approximate" | "adapter">,
  t: Translate,
): string | null {
  const { position, trust } = nav;
  const body = position
    ? trust === "UNTRUSTED"
      ? t("alertSpoof")
      : trust === "NO_FIX"
        ? t(nav.approximate ? "alertApprox" : "alertNoFix")
        : trust === "REACQUIRING"
          ? t("alertReacq")
          : null
    : null;
  return body && trust !== "REACQUIRING" && nav.adapter !== "on" ? `${body} ${t("alertPhoneOnly")}` : body;
}

/**
 * The trust alert, unfolded from the status pill. Under spoofing (`ghost`: the raw fix it claims) a button frames
 * both the dot and the claimed fix.
 */
export function TrustAlertCard({
  nav,
  text,
  ghost,
  showingGhost,
  onToggleGhost,
}: {
  nav: NavStatus;
  text: string;
  ghost: RawGnssFix | undefined;
  showingGhost: boolean;
  onToggleGhost(): void;
}) {
  const { t, language } = useT();
  const { position } = nav;
  return (
    <HudCard icon={nav.icon} tone={nav.color} lines={<T size={14} style={styles.alert}>{text}</T>}>
      {ghost && position && (
        <CardButton
          label={showingGhost ? t("backToMe") : t("showGhost")}
          sub={t("ghostClaim")
            .replace("{d}", formatDistance(haversineM(position, ghost), language))
            .replace("{dir}", cardinal(toDegrees(bearingRad(position, ghost)), language))}
          onPress={onToggleGhost}
        />
      )}
    </HudCard>
  );
}

/** The simulated outage's card (Developer settings, UI-SPEC §6.1): time, distance, the dot's error, "Restore GPS". */
export function OutageCard({
  outage,
  nowMs,
  onRestore,
}: {
  outage: SimulatedOutage;
  /** The position's timestamp. */
  nowMs: number;
  onRestore(): void;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  return (
    <HudCard
      icon="gps_off"
      tone={palette.warn}
      title={t("simOutage")}
      lines={
        <>
          <CardLine>
            {t("simOutageStats")
              .replace("{t}", formatDuration(nowMs - outage.startedAt))
              .replace("{d}", formatDistance(outage.distanceM ?? 0, language))}
          </CardLine>
          <CardLine>
            {outage.errorM === undefined
              ? t("simOutageNoGps")
              : t("simOutageError")
                  .replace("{e}", formatDistance(outage.errorM, language))
                  .replace("{m}", formatDistance(outage.maxErrorM ?? outage.errorM, language))}
          </CardLine>
        </>
      }
    >
      <CardButton label={t("restoreGps")} onPress={onRestore} />
    </HudCard>
  );
}

/**
 * Without trusted GPS: how long ago, and how far back, the last trusted fix was (SPEC §3.9). The simulated
 * outage's card and a manual position show their own, so it stays away then.
 */
export function SinceTrustedStrip({ position }: { position: PositionEstimate }) {
  const { t, language } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const trustedAt =
    position.trust !== "TRUSTED" && !position.manual && !position.simulatedOutage
      ? position.lastTrustedFixAt
      : undefined;
  const age = useAgeText(trustedAt);
  if (trustedAt === undefined) return null;
  const backM = position.distanceSinceTrustedM;
  const text =
    backM !== undefined && backM >= SINCE_TRUSTED_MIN_M
      ? t("sinceTrustedBack").replace("{age}", age).replace("{d}", formatDistance(backM, language))
      : t("sinceTrusted").replace("{age}", age);
  return (
    // Wraps: in Ukrainian the age and the distance back don't fit one line.
    <View style={[panel, hud.chip, styles.since]}>
      <GlassFill radius={Radius.rL} />
      <Icon name="history" size={16} color={palette.text2} />
      <T w="medium" size={13} style={styles.sinceText}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  alert: { lineHeight: 20 },
  since: { height: undefined, minHeight: 36, maxWidth: "100%", paddingVertical: 8, borderRadius: Radius.rL },
  sinceText: { flexShrink: 1, lineHeight: 17 },
});
