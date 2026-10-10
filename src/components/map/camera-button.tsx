import type { Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";

import { hud, usePanelStyle } from "./hud-card";
import type { CameraMode } from "./use-camera-mode";

export const CAMERA_BUTTON_SIZE = 52;

const CAMERA: Record<CameraMode, { icon: IconName; label: "follow" | "followHeading" | "free" }> = {
  follow: { icon: "my_location", label: "follow" },
  "follow-heading": { icon: "navigation", label: "followHeading" },
  free: { icon: "location_searching", label: "free" },
};

/** Shows the camera mode; a tap goes between follow and heading-up, and back to follow from free (UI-SPEC §6.2). */
export function CameraButton({ mode, onPress, ref }: { mode: CameraMode; onPress(): void; ref?: Ref<View> }) {
  const { t } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  return (
    <Pressable
      ref={ref}
      style={({ pressed }) => [panel, styles.button, pressed && hud.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={mode === "free" ? `${t(CAMERA.free.label)}, ${t("tapToFollow")}` : t(CAMERA[mode].label)}
    >
      <GlassFill radius={CAMERA_BUTTON_SIZE / 2} />
      <Icon name={CAMERA[mode].icon} size={24} color={mode === "free" ? palette.text2 : palette.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: "flex-end",
    width: CAMERA_BUTTON_SIZE,
    height: CAMERA_BUTTON_SIZE,
    borderRadius: CAMERA_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
