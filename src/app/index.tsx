import { useKeepAwake } from "expo-keep-awake";
import { BlurView } from "expo-blur";
import { Link, router, useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
    Animated,
    Linking,
    Pressable,
    StyleSheet,
    useColorScheme,
    View,
    type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MapSurface } from "@/components/map/map-surface";
import { RouteBanner } from "@/components/route/route-banner";
import { useVoiceGuidance, useVoiceMuted } from "@/components/route/use-voice-guidance";
import {
    COURSE_MIN_SPEED_MPS,
    useCompassHeading,
    useHeadingUp,
    walkingCompass,
} from "@/components/map/use-compass-heading";
import {
    cardinal,
    formatDistance,
    toDegrees,
} from "@/components/status/format-geo";
import { useSheetClosing } from "@/components/map/sheet-closing";
import { useNavStatus } from "@/components/status/use-nav-status";
import { GlassFill } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import { calibrationMock } from "@/mocks";
import { usePositionPermission } from "@/providers/position-provider";
import { useRoute } from "@/providers/route-provider";
import { useDevSettings, useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";
import { isOnboardingDone } from "@/services/preferences";

type CameraMode = "follow" | "follow-heading" | "free";

const CAMERA: Record<CameraMode, { icon: IconName; label: "follow" | "followHeading" | "free" }> = {
  follow: { icon: "my_location", label: "follow" },
  "follow-heading": { icon: "navigation", label: "followHeading" },
  free: { icon: "location_searching", label: "free" },
};

/** Below this the car stands: the driver may put it on the map. */
const STANDING_MPS = 1;
/** Offer putting the car on the map when the position is rougher than this (or has no direction), without GPS. */
const PLACE_OFFER_ACCURACY_M = 75;

/** Driving this long on a trip turns follow into heading-up (UI-SPEC §6.2). */
const AUTO_HEADING_UP_MS = 2000;

export default function HomeScreen() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const { t, language } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const { position, trust } = nav;
  const { permission, requestPermission } = usePositionPermission();
  const { route, startRoute, stopRoute } = useRoute();
  // A long press on the map drops a pin to route to (ROUTING-SPEC §8).
  const [pin, setPin] = useState<Coordinate | null>(null);
  const [voiceMuted, toggleVoice] = useVoiceMuted();
  const [cameraMode, setCameraMode] = useState<CameraMode>("follow");
  const [ghostView, setGhostView] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const recorderState = useRecorderSnapshot().state;
  const { outageButton } = useDevSettings();
  const runtime = useRuntime();
  const { position: navigator } = runtime;
  const outage = position?.simulatedOutage;
  const recording = recorderState === "recording";
  // A linger after engine off is still the same drive for the camera.
  const onTrip = recording || recorderState === "lingering";
  // Not in a car (no trip, no adapter): the phone compass may stand in for heading.
  const compass = walkingCompass(
    position,
    useCompassHeading(!recording && nav.adapter !== "on" && position != null),
  );
  const headingUp = useHeadingUp(position, compass);
  useVoiceGuidance(route, position?.speedMps, voiceMuted);

  // Once per trip: follow becomes heading-up when the car first drives off, and goes back
  // to follow when the trip ends unless the driver has picked a mode since.
  const autoHeadingUp = useRef<"armed" | "on" | "done">("armed");
  const driving = recording && (position?.speedMps ?? 0) > COURSE_MIN_SPEED_MPS;
  useEffect(() => {
    if (!driving || autoHeadingUp.current !== "armed") return;
    const timer = setTimeout(() => {
      if (cameraMode !== "follow") {
        autoHeadingUp.current = "done";
        return;
      }
      autoHeadingUp.current = "on";
      setCameraMode("follow-heading");
    }, AUTO_HEADING_UP_MS);
    return () => clearTimeout(timer);
  }, [driving, cameraMode]);
  useEffect(() => {
    if (onTrip) return;
    if (autoHeadingUp.current === "on") {
      setCameraMode((mode) => (mode === "follow-heading" ? "follow" : mode));
    }
    autoHeadingUp.current = "armed";
  }, [onTrip]);
  const pickCameraMode = (next: (mode: CameraMode) => CameraMode) => {
    if (autoHeadingUp.current === "on") autoHeadingUp.current = "done";
    setCameraMode(next);
  };

  useEffect(() => {
    if (!isOnboardingDone()) router.push("/onboarding");
  }, []);

  // Tap never enters free (only map gestures do); from free it returns to follow.
  const toggleCameraMode = () => {
    setGhostView(false);
    pickCameraMode((mode) => (mode === "follow" ? "follow-heading" : "follow"));
  };

  const enableLocation = async () => {
    setRequesting(true);
    try {
      await requestPermission();
    } finally {
      setRequesting(false);
    }
  };

  const accuracy = position ? Math.round(position.accuracyM) : null;
  const accuracyText = accuracy == null ? "—" : `±${accuracy} m`;
  const accuracyColor =
    accuracy != null && accuracy > 25 && trust !== "TRUSTED" ? palette.warn.c : palette.text;
  const speed =
    position?.speedMps == null ? "—" : String(Math.round(position.speedMps * 3.6));
  const isDenied = permission?.status === "denied";
  const needsPermission = permission != null && !permission.granted;
  const ghost = trust === "UNTRUSTED" ? position?.rawGnss : undefined;
  const showingGhost = ghostView && ghost != null;
  const alertBody = position
    ? trust === "UNTRUSTED"
      ? t("alertSpoof")
      : trust === "NO_FIX"
        ? t(nav.approximate ? "alertApprox" : "alertNoFix")
        : trust === "REACQUIRING"
          ? t("alertReacq")
          : null
    : null;
  const alertText =
    alertBody && trust !== "REACQUIRING" && nav.adapter !== "on"
      ? `${alertBody} ${t("alertPhoneOnly")}`
      : alertBody;

  // The explanation under the status pill stays folded to leave room for the map; a tap on the
  // pill opens it.
  const showCutGps = outageButton && position != null && !outage;
  const hasDetails = outage != null || alertText != null || showCutGps;
  const [detailsToggled, setDetailsOpen] = useState(false);
  const detailsOpen = detailsToggled && hasDetails;

  const panel = [
    styles.panel,
    { boxShadow: palette.shadow },
  ];

  // Putting the car on the map (NAVIGATOR-SPEC §6.2): only while it stands; moving off cancels.
  const [placing, setPlacing] = useState<"position" | "heading" | null>(null);
  const [placeAt, setPlaceAt] = useState<Coordinate | null>(null);
  const placeCenter = useRef<Coordinate | null>(null);
  const [placeFrom, setPlaceFrom] = useState<Coordinate | null>(null);
  const standing = position != null && (position.speedMps ?? 0) < STANDING_MPS;
  // Lost enough to offer it: no GPS, and a rough position or no direction.
  const lost =
    position != null &&
    trust !== "TRUSTED" &&
    (position.accuracyM > PLACE_OFFER_ACCURACY_M || position.headingRad == null);
  const startPlacing = () => {
    const from = position ? { lat: position.lat, lon: position.lon } : null;
    placeCenter.current = from;
    setPlaceFrom(from);
    setPlaceAt(null);
    setPlacing("position");
    pickCameraMode(() => "free");
  };
  const stopPlacing = () => {
    setPlacing(null);
    setPlaceAt(null);
    pickCameraMode(() => "follow");
  };
  const placeHere = () => {
    const at = placeCenter.current;
    if (!at) return;
    setPlaceAt(at);
    setPlacing("heading");
  };
  const finishPlacing = (towards?: Coordinate) => {
    if (placeAt) navigator.setUserPosition(placeAt, towards ? bearingRad(placeAt, towards) : undefined);
    stopPlacing();
  };
  // Moving off cancels (state adjusted during render, not in an effect).
  if (placing && !standing) {
    setPlacing(null);
    setPlaceAt(null);
    setCameraMode("follow");
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <MapSurface
        mode={cameraMode}
        ghostView={showingGhost}
        compass={compass}
        headingUpRad={headingUp}
        onUserInteraction={() => pickCameraMode(() => "free")}
        onLongPress={setPin}
        pin={placing ? placeAt : pin}
        logCamera={(text) => runtime.recorder.note(text)}
        placing={placing}
        placeFrom={placeFrom}
        onCenter={(at) => (placeCenter.current = at)}
        onTap={finishPlacing}
      />
      {placing === "position" && (
        <View pointerEvents="none" style={styles.placeTarget}>
          <Icon name="location_on" size={44} color={palette.accent} />
        </View>
      )}
      <View
        pointerEvents="box-none"
        style={[
          styles.overlay,
          {
            paddingTop: insets.top + 10,
            paddingBottom: Math.max(insets.bottom - 6, 14),
          },
        ]}
      >
        <View pointerEvents="box-none" style={styles.topStack}>
          <View style={styles.topRow}>
            <Pressable
              onPress={() => setDetailsOpen((open) => !open)}
              disabled={!hasDetails}
              accessibilityRole="button"
              accessibilityState={{ expanded: detailsOpen }}
              style={[panel, styles.statusPill]}
            >
              <GlassFill radius={Radius.pill} />
              <View style={[styles.statusHalo, { backgroundColor: nav.color.a }]}>
                <View style={[styles.statusDot, { backgroundColor: nav.color.c }]} />
              </View>
              <View style={styles.statusCopy}>
                <T w="semibold" size={15} numberOfLines={1}>
                  {nav.sentence}
                </T>
                <T size={12} color={palette.text2} numberOfLines={1}>
                  {position ? (
                    <>
                      {nav.source} · <T size={12} color={accuracyColor}>{accuracyText}</T>
                    </>
                  ) : (
                    "—"
                  )}
                </T>
              </View>
              {hasDetails && (
                <View style={{ transform: [{ rotate: detailsOpen ? "-90deg" : "90deg" }] }}>
                  <Icon name="chevron_right" size={16} color={palette.text2} />
                </View>
              )}
            </Pressable>
            <View style={[panel, styles.speedPanel]}>
              <GlassFill radius={28} />
              <T w="light" size={28} style={styles.speedNumber}>
                {speed}
              </T>
              <T size={11} color={palette.text2}>
                {t("speed")}
              </T>
            </View>
          </View>

          {outage && detailsOpen && (
            <View style={[panel, styles.alertCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.warn.a }]}>
                  <Icon name="gps_off" size={20} color={palette.warn.c} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t("simOutage")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t("simOutageStats")
                      .replace("{t}", formatDuration(position.timestamp - outage.startedAt))
                      .replace("{d}", formatDistance(outage.distanceM ?? 0, language))}
                  </T>
                  <T size={13} color={palette.text2}>
                    {outage.errorM === undefined
                      ? t("simOutageNoGps")
                      : t("simOutageError")
                          .replace("{e}", formatDistance(outage.errorM, language))
                          .replace("{m}", formatDistance(outage.maxErrorM ?? outage.errorM, language))}
                  </T>
                </View>
              </View>
              <Pressable
                onPress={() => navigator.setSimulatedOutage(false)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.ghostButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
              >
                <T w="semibold" size={14} color={palette.accent}>
                  {t("restoreGps")}
                </T>
              </Pressable>
            </View>
          )}

          {placing && (
            <View style={[panel, styles.alertCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.accent + "22" }]}>
                  <Icon name={placing === "position" ? "location_on" : "navigation"} size={20} color={palette.accent} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t(placing === "position" ? "placeTitle" : "placeHeadingTitle")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t(placing === "position" ? "placeHint" : "placeHeadingHint")}
                  </T>
                </View>
              </View>
              <View style={styles.answerRow}>
                <Pressable
                  onPress={stopPlacing}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.ghostButton, styles.answerButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                >
                  <T w="semibold" size={14} color={palette.text2}>
                    {t("placeCancel")}
                  </T>
                </Pressable>
                <Pressable
                  onPress={placing === "position" ? placeHere : () => finishPlacing()}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.ghostButton, styles.answerButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                >
                  <T w="semibold" size={14} color={palette.accent}>
                    {t(placing === "position" ? "placeHere" : "placeSkipHeading")}
                  </T>
                </Pressable>
              </View>
            </View>
          )}

          {!placing && !position?.poseQuestion && standing && lost && (
            <Pressable
              onPress={startPlacing}
              style={({ pressed }) => [panel, styles.calChip, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <GlassFill radius={Radius.pill} />
              <Icon name="location_on" size={16} color={palette.accent} />
              <T w="semibold" size={13} color={palette.accent}>
                {t("placeOffer")}
              </T>
            </Pressable>
          )}

          {!placing && position?.poseQuestion && (
            <View style={[panel, styles.alertCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.warn.a }]}>
                  <Icon name="directions_car" size={20} color={palette.warn.c} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t("poseQuestion")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t("poseQuestionWhy").replace("{d}", formatDistance(position.poseQuestion.distanceM, language))}
                  </T>
                </View>
              </View>
              <View style={styles.answerRow}>
                {([true, false] as const).map((here) => (
                  <Pressable
                    key={String(here)}
                    onPress={() => {
                      navigator.answerPose(here);
                      // Not there: show where it is instead, if it stands.
                      if (!here && standing) startPlacing();
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.ghostButton, styles.answerButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                  >
                    <T w="semibold" size={14} color={palette.accent}>
                      {t(here ? "poseYes" : "poseNo")}
                    </T>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {nav.protocolSearch && (
            <View style={[panel, styles.calChip]}>
              <GlassFill radius={Radius.pill} />
              <Icon name="bluetooth" size={16} color={palette.warn.c} />
              <T w="semibold" size={13} color={palette.warn.c}>
                {t("obdFindingProtocol")}
              </T>
            </View>
          )}

          {showCutGps && detailsOpen && (
            <Pressable
              onPress={() => navigator.setSimulatedOutage(true)}
              style={({ pressed }) => [panel, styles.calChip, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <GlassFill radius={Radius.pill} />
              <Icon name="gps_off" size={16} color={palette.accent} />
              <T w="semibold" size={13} color={palette.accent}>
                {t("cutGps")}
              </T>
            </Pressable>
          )}

          {alertText && !outage && detailsOpen && (
            <View style={[panel, styles.alertCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: nav.color.a }]}>
                  <Icon name={nav.icon} size={20} color={nav.color.c} />
                </View>
                <T size={14} style={styles.alertText}>
                  {alertText}
                </T>
              </View>
              {ghost && position && (
                <Pressable
                  onPress={() => setGhostView(!showingGhost)}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.ghostButton,
                    { backgroundColor: palette.surface },
                    pressed && styles.pressed,
                  ]}
                >
                  <T w="semibold" size={14} color={palette.accent}>
                    {showingGhost ? t("backToMe") : t("showGhost")}
                  </T>
                  <T size={12} color={palette.text2}>
                    {t("ghostClaim")
                      .replace("{d}", formatDistance(haversineM(position, ghost), language))
                      .replace("{dir}", cardinal(toDegrees(bearingRad(position, ghost)), language))}
                  </T>
                </Pressable>
              )}
            </View>
          )}

          {position && trust === "TRUSTED" && calibrationMock.status === "not-calibrated" && (
            <Link href="/calibration" asChild>
              <Pressable
                style={StyleSheet.flatten<ViewStyle>([panel, styles.calChip])}
                accessibilityRole="button"
              >
                <GlassFill radius={Radius.pill} />
                <View style={[styles.calDot, { backgroundColor: palette.warn.c }]} />
                <T w="medium" size={13}>
                  {t("notCalibrated")}
                </T>
                <T w="semibold" size={13} color={palette.accent}>
                  {t("calibrate")}
                </T>
              </Pressable>
            </Link>
          )}

          {route && (
            <RouteBanner route={route} nowMs={position?.timestamp ?? 0} onStop={stopRoute} muted={voiceMuted} onToggleVoice={toggleVoice} />
          )}
        </View>

        {!position && (
          <CenterCard>
            {needsPermission ? (
              <>
                <Icon name="location_off" size={34} color={palette.bad.c} />
                <T w="semibold" size={19} style={styles.centerText}>
                  {t("locationOff")}
                </T>
                <T size={14} color={palette.text2} style={styles.centerBody}>
                  {t("locationNeeded")}
                </T>
                <Pressable
                  onPress={
                    isDenied && !permission.canAskAgain
                      ? () => void Linking.openURL("app-settings:")
                      : enableLocation
                  }
                  disabled={requesting}
                  style={({ pressed }) => [
                    styles.centerButton,
                    { backgroundColor: palette.accent },
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                >
                  <T w="semibold" size={15} color={palette.onAccent}>
                    {isDenied && !permission.canAskAgain ? t("openSettings") : t("enableLocation")}
                  </T>
                </Pressable>
              </>
            ) : (
              <>
                <Pulse>
                  <Icon name="satellite_alt" size={34} color={palette.accent} />
                </Pulse>
                <T w="semibold" size={19} style={styles.centerText}>
                  {t("waitingForGps")}
                </T>
                <T size={14} color={palette.text2} style={styles.centerBody}>
                  {t("waitingBody")}
                </T>
              </>
            )}
          </CenterCard>
        )}

        <View pointerEvents="box-none" style={styles.bottomStack}>
          {pin && (
            <View style={[panel, styles.pinCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.accentA }]}>
                  <Icon name="place" size={20} color={palette.accent} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t("droppedPin")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {position
                      ? `${formatDistance(haversineM(position, pin), language)} · ${cardinal(toDegrees(bearingRad(position, pin)), language)}`
                      : `${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`}
                  </T>
                </View>
              </View>
              <View style={styles.pinActions}>
                <Pressable
                  onPress={() => setPin(null)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                >
                  <T w="semibold" size={15} color={palette.text}>
                    {t("cancel")}
                  </T>
                </Pressable>
                <Pressable
                  onPress={() => {
                    startRoute({ lat: pin.lat, lon: pin.lon });
                    setPin(null);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.accent }, pressed && styles.pressed]}
                >
                  <Icon name="alt_route" size={16} color={palette.onAccent} />
                  <T w="semibold" size={15} color={palette.onAccent}>
                    {t("routeHere")}
                  </T>
                </Pressable>
              </View>
            </View>
          )}
          <Pressable
            style={({ pressed }) => [panel, styles.cameraButton, pressed && styles.pressed]}
            onPress={toggleCameraMode}
            accessibilityRole="button"
            accessibilityLabel={
              cameraMode === "free"
                ? `${t(CAMERA.free.label)}, ${t("tapToFollow")}`
                : t(CAMERA[cameraMode].label)
            }
          >
            <GlassFill radius={26} />
            <Icon
              name={CAMERA[cameraMode].icon}
              size={24}
              color={cameraMode === "free" ? palette.text2 : palette.accent}
            />
          </Pressable>
          <View style={[panel, styles.bottomCard]}>
            <GlassFill radius={30} />
            <HudAction icon="alt_route" label={t("route")} href="/route" />
            <HudAction
              icon="directions_car"
              label={t("vehicle")}
              href="/vehicle"
              recording={recording}
              recordingLabel={t("recording")}
            />
            <HudAction icon="more_horiz" label={t("more")} href="/more" />
          </View>
        </View>
      </View>
      <SheetBlur />
    </View>
  );
}

/** m:ss */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function HudAction({
  icon,
  label,
  href,
  recording,
  recordingLabel,
}: {
  icon: IconName;
  label: string;
  href: "/route" | "/vehicle" | "/more";
  recording?: boolean;
  recordingLabel?: string;
}) {
  const palette = usePalette();
  return (
    // Link asChild drops function styles, so press feedback lives on the content.
    <Link href={href} asChild>
      <Pressable style={styles.action} accessibilityRole="button">
        {({ pressed }) => (
          <View
            style={[
              styles.actionContent,
              pressed && { backgroundColor: palette.line },
            ]}
          >
            <Icon name={icon} size={24} color={palette.text} />
            {recording && (
              <View
                style={[styles.recDot, { backgroundColor: palette.bad.c, borderColor: palette.groupBg }]}
                accessibilityLabel={recordingLabel}
              />
            )}
            <T w="medium" size={12}>
              {label}
            </T>
          </View>
        )}
      </Pressable>
    </Link>
  );
}

/** Blurs the map and the HUD over it while a sheet (route, vehicle, more…) is open over this screen. */
function SheetBlur() {
  // Blurred while a sheet is open, and un-blurs as soon as it starts closing.
  const isFocused = useIsFocused();
  const closing = useSheetClosing();
  const focused = isFocused || closing;
  const dark = useColorScheme() === "dark";
  const [opacity] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: focused ? 0 : 1,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [focused, opacity]);
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <BlurView intensity={40} tint={dark ? "dark" : "light"} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

function CenterCard({ children }: React.PropsWithChildren) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.centerCard,
        { backgroundColor: palette.sheetBg, boxShadow: palette.cardShadow },
      ]}
    >
      {children}
    </View>
  );
}

function Pulse({ children }: React.PropsWithChildren) {
  const [opacity] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    paddingHorizontal: 14,
  },
  panel: { borderCurve: "continuous" },
  pressed: { opacity: 0.75 },
  topStack: { gap: 10 },
  topRow: { flexDirection: "row", alignItems: "stretch", gap: 10 },
  statusPill: {
    flex: 1,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 12,
    paddingRight: 18,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  statusHalo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: { width: 12, height: 12, borderRadius: 6 },
  statusCopy: { flex: 1, gap: 1 },
  speedPanel: {
    minWidth: 76,
    minHeight: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  speedNumber: {
    lineHeight: 28,
    letterSpacing: -0.8,
    fontVariant: ["tabular-nums"],
  },
  recDot: {
    position: "absolute",
    top: 8,
    right: 22,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  alertCard: { gap: 12, padding: 16, borderRadius: Radius.rL },
  alertRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  alertIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  alertText: { flex: 1, lineHeight: 20 },
  answerRow: { flexDirection: "row", gap: 8 },
  // The pin's tip on the map centre: the icon is 44 high, its tip at the bottom.
  placeTarget: { position: "absolute", left: "50%", top: "50%", marginLeft: -22, marginTop: -40 },
  answerButton: { flex: 1, alignItems: "center" },
  ghostButton: {
    gap: 2,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
  },
  calChip: {
    alignSelf: "flex-start",
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: Radius.pill,
  },
  calDot: { width: 8, height: 8, borderRadius: 4 },
  pinCard: { gap: 12, padding: 16, borderRadius: Radius.rL },
  pinActions: { flexDirection: "row", gap: 10 },
  pinButton: {
    flex: 1,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: Radius.pill,
  },
  centerCard: {
    alignSelf: "center",
    alignItems: "center",
    gap: 10,
    width: "88%",
    maxWidth: 350,
    paddingHorizontal: 22,
    paddingVertical: 24,
    borderRadius: Radius.rL,
    borderCurve: "continuous",
  },
  centerText: { textAlign: "center" },
  centerBody: { textAlign: "center", lineHeight: 20 },
  centerButton: {
    alignSelf: "stretch",
    height: 50,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.pill,
  },
  bottomStack: { gap: 12 },
  cameraButton: {
    alignSelf: "flex-end",
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomCard: {
    flexDirection: "row",
    gap: 4,
    padding: 6,
    borderRadius: 30,
  },
  action: { flex: 1 },
  actionContent: {
    height: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: 24,
  },
});
