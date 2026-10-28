import { StyleSheet, View } from "react-native";

import { formatDistance } from "@/components/status/format-geo";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

import { usePanelStyle } from "./hud-card";
import { SpeedLimitSign } from "./speed-limit-sign";
import type { CameraShown } from "./use-camera-warning";

/** The distance as the card says it: 10 m steps near, 50 m farther, so the number doesn't tick every metre. */
const shownDistanceM = (m: number) => (m < 200 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50);

/**
 * A speed camera ahead (UI-SPEC §6.5): "Speed camera in 600 m", the limit at the camera as its sign (said only to a
 * screen reader), and a bar filling as the car comes to it. Past the driver's margin over that limit, red: "Slow down"
 * (the sign says to what) and the distance under it.
 */
export function CameraCard({ camera }: { camera: CameraShown }) {
  const { t, language } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const red = camera.slowDown && camera.limitKph !== undefined;
  const distance = t("cameraIn").replace("{distance}", formatDistance(shownDistanceM(camera.distanceM), language));
  const title = red ? t("cameraSlowDown") : distance;
  const line = red ? distance : null;
  const limit = camera.limitKph !== undefined ? t("cameraLimit").replace("{limit}", String(camera.limitKph)) : null;
  const ink = red ? palette.bad.fg : palette.text;
  return (
    <View
      style={[panel, styles.card]}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={[title, line, limit].filter(Boolean).join(". ")}
    >
      {red ? <View style={[styles.fill, { backgroundColor: palette.bad.c }]} /> : <GlassFill radius={Radius.rL} />}
      <View style={[styles.icon, { backgroundColor: red ? "rgba(255,255,255,0.18)" : palette.text }]}>
        <Icon name="speed_camera" size={26} color={red ? palette.bad.fg : palette.bg} />
      </View>
      <View style={styles.text}>
        <T w="semibold" size={red ? 17 : 15} color={ink}>
          {title}
        </T>
        {line && (
          <T size={12} color={red ? palette.bad.fg : palette.text2}>
            {line}
          </T>
        )}
      </View>
      {camera.limitKph !== undefined && (
        // On red, a ring of the sign's white keeps its own red ring apart.
        <View style={red && [styles.signOnRed, { borderColor: palette.signFill }]}>
          <SpeedLimitSign kph={camera.limitKph} />
        </View>
      )}
      <View style={[styles.track, { backgroundColor: red ? "rgba(255,255,255,0.25)" : palette.line }]}>
        <View style={[styles.bar, { width: `${Math.round(camera.progress * 100)}%`, backgroundColor: red ? palette.bad.fg : palette.text }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 12,
    paddingBottom: 14,
    paddingHorizontal: 12,
    borderRadius: Radius.rL,
  },
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: Radius.rL },
  icon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  signOnRed: { borderRadius: 24, borderWidth: 2 },
  // Inside the rounded corners: the card isn't clipped (its shadow would go with it).
  track: { position: "absolute", left: 20, right: 20, bottom: 5, height: 3, borderRadius: 1.5 },
  bar: { height: 3, borderRadius: 1.5 },
});
