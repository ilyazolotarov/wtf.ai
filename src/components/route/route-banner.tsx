import { useRef } from "react";
import { Pressable, processColor, StyleSheet, View } from "react-native";

import { formatDistance } from "@/components/status/format-geo";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";

import {
  AudioOutputPicker,
  type AudioOutputPickerHandle,
  canPickAudioOutput,
  openAudioOutputPanel,
} from "../../../modules/audio-output/src/AudioOutputModule";

import {
  formatArrival,
  formatDurationS,
  formatManeuverDistance,
  MANEUVER_ICON,
  MANEUVER_TEXT,
  PROBLEM_TEXT,
} from "./guidance-text";

/**
 * The route at the top of the map (ROUTING-SPEC §8): the next maneuver and the distance to it, the one after when
 * close, and what's left; or planning, failure, arrival. `nowMs` is the position's time (for the arrival clock).
 * The voice button: a tap mutes; holding it opens the system's audio output picker (iOS, Android); `offPhone` (the voice goes to a
 * car's Bluetooth or AirPlay) shows the output glyph instead of the speaker.
 */
export function RouteBanner({
  route,
  nowMs,
  onStop,
  muted,
  onToggleVoice,
  offPhone = false,
}: {
  route: RouteSnapshot;
  nowMs: number;
  onStop(): void;
  muted: boolean;
  /** Absent: no voice button (the voice is off in Settings). */
  onToggleVoice?: () => void;
  offPhone?: boolean;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  const picker = useRef<AudioOutputPickerHandle>(null);
  const openPicker = () => {
    if (AudioOutputPicker) void picker.current?.open().catch(() => false);
    else openAudioOutputPanel();
  };
  const instruction = (m: Maneuver) => t(MANEUVER_TEXT[m.kind]).replace("{n}", String(m.exit ?? 1));

  let icon: IconName = "alt_route";
  let iconBg: string = palette.accent;
  let title: string;
  let distance: string | null = null;
  let then: Maneuver | null = null;
  let sub: string | null = null;
  let subColor: string = palette.text2;

  if (route.status === "planning") {
    title = t("planningRoute");
    sub = route.destination.name ?? null;
  } else if (route.status === "failed") {
    icon = "close";
    iconBg = palette.bad.c;
    title = t("routeFailedTitle");
    sub = t(route.failure ? PROBLEM_TEXT[route.failure] : "routeCancelled");
  } else if (route.guidance?.state === "arrived") {
    icon = "flag";
    iconBg = palette.ok.c;
    title = t("arrived");
    sub = route.destination.name ?? null;
  } else {
    const maneuvers = route.maneuvers!;
    const g = route.guidance;
    const nextIndex = g?.nextIndex ?? Math.min(1, maneuvers.length - 1);
    const next = maneuvers[nextIndex];
    icon = MANEUVER_ICON[next.kind];
    title = instruction(next);
    distance = formatManeuverDistance(g?.toNextM ?? next.atM, language);
    then = g?.thenIndex != null ? maneuvers[g.thenIndex] : null;
    const remainingM = g?.remainingM ?? route.plan!.lengthM;
    const remainingS = g?.remainingS ?? route.plan!.durationS;
    if (route.replanning) {
      sub = t("replanning");
      subColor = palette.warn.c;
    } else if (g?.state === "off" || g?.state === "leaving") {
      sub = route.replanFailure ? t("replanFailed") : null;
      subColor = palette.warn.c;
    } else if (g?.state === "unsure") {
      sub = t("routeUnsure");
      subColor = palette.warn.c;
    }
    sub ??= `${formatDistance(remainingM, language)} · ${formatDurationS(remainingS, t)} · ${t("arriveAt").replace("{time}", formatArrival(remainingS, nowMs))}`;
  }

  return (
    <View style={[styles.banner, { boxShadow: palette.shadow }]}>
      <GlassFill radius={Radius.rL} />
      <View style={[styles.icon, { backgroundColor: iconBg }]}>
        <Icon name={icon} size={26} color={palette.onAccent} />
      </View>
      <View style={styles.copy}>
        {distance && (
          <T w="semibold" size={24} style={styles.distance}>
            {distance}
          </T>
        )}
        <T w="semibold" size={distance ? 15 : 17} numberOfLines={2}>
          {title}
        </T>
        {then && (
          <View style={styles.then}>
            <T size={13} color={palette.text2}>
              {t("thenManeuver")}
            </T>
            <Icon name={MANEUVER_ICON[then.kind]} size={13} color={palette.text2} />
            <T size={13} color={palette.text2} numberOfLines={1}>
              {instruction(then)}
            </T>
          </View>
        )}
        {sub && (
          <T size={13} color={subColor} numberOfLines={2}>
            {sub}
          </T>
        )}
      </View>
      <View style={styles.buttons}>
        <Pressable
          onPress={onStop}
          accessibilityRole="button"
          accessibilityLabel={t("stopGuidance")}
          hitSlop={HIT_SLOP}
          style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
        >
          <Icon name="close" size={17} color={palette.text2} />
        </Pressable>
        {route.status === "active" && onToggleVoice && (
          <Pressable
            onPress={onToggleVoice}
            onLongPress={canPickAudioOutput ? openPicker : undefined}
            accessibilityRole="button"
            accessibilityLabel={t(muted ? "voiceOff" : "voiceOn")}
            accessibilityHint={canPickAudioOutput ? t("voiceOutputHint") : undefined}
            accessibilityActions={canPickAudioOutput ? [{ name: "activate" }, { name: "longpress", label: t("voiceOutput") }] : undefined}
            onAccessibilityAction={(e) => (e.nativeEvent.actionName === "longpress" ? openPicker() : onToggleVoice())}
            hitSlop={HIT_SLOP}
            style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
          >
            <Icon
              name={muted ? "volume_off" : offPhone ? "airplay" : "volume_up"}
              size={17}
              color={muted ? palette.text2 : palette.accent}
            />
            {AudioOutputPicker && (
              // Invisible: only its sheet is wanted, opened by the long press.
              <AudioOutputPicker
                ref={picker}
                pointerEvents="none"
                style={styles.picker}
                tint={processColor(palette.text2) as number}
                activeTint={processColor(palette.accent) as number}
              />
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const HIT_SLOP = { top: 6, bottom: 6, left: 12, right: 12 };

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: Radius.rL,
    borderCurve: "continuous",
  },
  icon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, gap: 2 },
  distance: { fontVariant: ["tabular-nums"], letterSpacing: -0.4 },
  then: { flexDirection: "row", alignItems: "center", gap: 5 },
  // Apart, with taps that don't reach the other button: × ends the route.
  buttons: { gap: 20, alignSelf: "stretch", justifyContent: "space-between" },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  picker: { position: "absolute", width: 1, height: 1, opacity: 0 },
  pressed: { opacity: 0.7 },
});
