import { useKeepAwake } from "expo-keep-awake";
import { Link, router, useIsFocused } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
    Animated,
    Linking,
    Pressable,
    StyleSheet,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MapSurface } from "@/components/map/map-surface";
import { useHasUsableMap } from "@/config/map";
import { RegionPrompt } from "@/components/map/region-prompt";
import { RouteBanner } from "@/components/route/route-banner";
import { useAudioOutput } from "@/components/route/use-audio-output";
import { useVoiceGuidance, useVoiceMuted, useVoiceVolume } from "@/components/route/use-voice-guidance";
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
import { useLinkBadge, useNavStatus, type LinkBadge } from "@/components/status/use-nav-status";
import { BlurTarget, GlassFill, MapBlur } from "@/components/ui/glass-fill";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import { usePositionPermission } from "@/providers/position-provider";
import { useHeldRoute, useRoute } from "@/providers/route-provider";
import { useDevSettings, useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";
import { onPlacingRequest, STANDING_MPS, takePlacingRequest } from "@/services/navigation/place-request";
import { isOnboardingDone } from "@/services/preferences";

type CameraMode = "follow" | "follow-heading" | "free";

const CAMERA: Record<CameraMode, { icon: IconName; label: "follow" | "followHeading" | "free" }> = {
  follow: { icon: "my_location", label: "follow" },
  "follow-heading": { icon: "navigation", label: "followHeading" },
  free: { icon: "location_searching", label: "free" },
};

/** Offer putting the car on the map when the position is rougher than this (or has no direction), without GPS. */
const PLACE_OFFER_ACCURACY_M = 75;
/**
 * …and when nothing has vouched for the dot in this far of dead reckoning. `accuracyM` alone is not enough:
 * the filter reports its own spread, which stays a few metres however wrong the dot is. On 2026-10-06 the car
 * stood at a filling station 10 km from the dot for 12 min at ±5 m, so the chip was never offered — the one
 * control that could have fixed it was hidden by the number that was broken.
 */
const PLACE_OFFER_DISTANCE_M = 5000;
/** The confirmed placing stays drawn until the dot is this far from it (the car drove off). */
const PLACED_SHOWN_M = 50;
/** Driven less than this since the last trusted fix, the chip gives only its age. */
const SINCE_TRUSTED_MIN_M = 50;

/** How often the manual position's age ("12 min ago") is redrawn; also the last trusted fix's. */
const MANUAL_AGE_REFRESH_MS = 15_000;

/** Driving this long on a trip turns follow into heading-up (UI-SPEC §6.2). */
const AUTO_HEADING_UP_MS = 2000;

export default function HomeScreen() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const { t, language } = useT();
  const palette = usePalette();
  const nav = useNavStatus();
  const linkBadge = useLinkBadge();
  const { position, trust } = nav;
  const { permission, requestPermission } = usePositionPermission();
  const { route, startRoute, stopRoute } = useRoute();
  // A route asked for without an adapter waits here for the driver's word (UI-SPEC §6.3).
  const held = useHeldRoute();
  // A long press on the map drops a pin to route to (ROUTING-SPEC §8), or to say the car is there.
  const [pin, setPin] = useState<Coordinate | null>(null);
  const [voiceMuted, toggleVoice] = useVoiceMuted();
  // Volume 0 in Settings: no voice, and no button for it.
  const voiceOff = useVoiceVolume() === 0;
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
  useVoiceGuidance(route, position?.speedMps, voiceMuted || voiceOff);
  const audioOutput = useAudioOutput(route?.status === "active");

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

  // First run: onboarding, then a map to download. Each time the map is back on top (the
  // last region deleted, say), it asks again: the app has no online map.
  const screenFocused = useIsFocused();
  const mapReady = useHasUsableMap();
  useEffect(() => {
    if (!screenFocused) return;
    if (!isOnboardingDone()) router.push("/onboarding");
    else if (!mapReady) router.push("/map-setup");
  }, [screenFocused, mapReady]);

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
  const [placeHeading, setPlaceHeading] = useState<number | null>(null);
  // The confirmed placing stays on the map until the car has driven away from it.
  const [placed, setPlaced] = useState<{ at: Coordinate; headingRad: number | null } | null>(null);
  if (placed && position && haversineM(position, placed.at) > PLACED_SHOWN_M) setPlaced(null);
  const placeCenter = useRef<Coordinate | null>(null);
  const [placeFrom, setPlaceFrom] = useState<Coordinate | null>(null);
  const standing = position != null && (position.speedMps ?? 0) < STANDING_MPS;
  // The driver may say where the car is from a pin or a search result whenever it isn't moving, also before any
  // fix at all (indoors, jammed): the manual position is shown without one (NAVIGATOR-SPEC §6.3).
  const mayPlace = position == null || standing;
  // Lost enough to offer it: no GPS, and nothing vouching for the dot — rough, no direction, off any road,
  // or a long way on dead reckoning. A confident filter on the wrong road looks like none of the first three.
  const lost =
    position != null &&
    trust !== "TRUSTED" &&
    (position.accuracyM > PLACE_OFFER_ACCURACY_M ||
      position.headingRad == null ||
      position.mapMatch === "offroad" ||
      (position.distanceSinceTrustedM ?? 0) > PLACE_OFFER_DISTANCE_M);
  // From the dot, or from where the driver says the car is (a dropped pin, a search result).
  const startPlacing = (at?: Coordinate) => {
    const from = at ?? (position ? { lat: position.lat, lon: position.lon } : null);
    setPin(null);
    placeCenter.current = from;
    setPlaceFrom(from);
    setPlaceAt(null);
    setPlaceHeading(null);
    setPlaced(null);
    setPlacing("position");
    pickCameraMode(() => "free");
  };
  const stopPlacing = () => {
    setPlacing(null);
    setPlaceAt(null);
    setPlaceHeading(null);
    pickCameraMode(() => "follow");
  };
  const placeHere = () => {
    const at = placeCenter.current;
    if (!at) return;
    setPlaceAt(at);
    setPlacing("heading");
  };
  // A tap aims the arrow (again and again); Confirm applies it, only once there is a heading.
  const aimPlacing = (towards: Coordinate) => {
    if (placeAt) setPlaceHeading(bearingRad(placeAt, towards));
  };
  const finishPlacing = () => {
    if (!placeAt || placeHeading === null) return;
    navigator.setUserPosition(placeAt, placeHeading);
    setPlaced({ at: placeAt, headingRad: placeHeading });
    stopPlacing();
  };
  // A position set on the map (NAVIGATOR-SPEC §6.3): its age on the chip, "still here?" after 15 min.
  const manual = position?.manual;
  const manualNow = useNowMs(manual != null, MANUAL_AGE_REFRESH_MS);
  const manualAge = manual ? formatAge(manualNow - manual.confirmedAt, t) : "";
  // Without trusted GPS: how long ago, and how far back, the last trusted fix was (SPEC §3.9). The
  // simulated outage's card and a manual position show their own.
  const trustedAt = trust !== "TRUSTED" && !manual && !outage ? position?.lastTrustedFixAt : undefined;
  const trustedNow = useNowMs(trustedAt !== undefined, MANUAL_AGE_REFRESH_MS);
  const trustedBackM = position?.distanceSinceTrustedM;
  const sinceTrusted =
    trustedAt === undefined
      ? null
      : trustedBackM !== undefined && trustedBackM >= SINCE_TRUSTED_MIN_M
        ? t("sinceTrustedBack")
            .replace("{age}", formatAge(trustedNow - trustedAt, t))
            .replace("{d}", formatDistance(trustedBackM, language))
        : t("sinceTrusted").replace("{age}", formatAge(trustedNow - trustedAt, t));
  // Forgetting it (✕, or "no" to "still here?") also takes the placing's mark off the map.
  const forgetManual = (notHere = false) => {
    if (notHere) navigator.answerManual(false);
    else navigator.discardManualPosition();
    setPlaced(null);
  };
  // "I'm here" on a search result (route screen): placing starts there.
  const takePlacing = useEffectEvent(() => {
    const at = takePlacingRequest();
    if (at && mayPlace) startPlacing(at);
  });
  // The map stays mounted under the route sheet, so the request always comes while subscribed.
  useEffect(() => onPlacingRequest(() => takePlacing()), []);
  // Moving off cancels (state adjusted during render, not in an effect).
  if (placing && !mayPlace) {
    setPlacing(null);
    setPlaceAt(null);
    setPlaceHeading(null);
    setCameraMode("follow");
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <BlurTarget>
        <MapSurface
          mode={cameraMode}
          ghostView={showingGhost}
          compass={compass}
          headingUpRad={headingUp}
          onUserInteraction={() => pickCameraMode(() => "free")}
          onLongPress={setPin}
          pin={placing ? null : pin}
          logCamera={(text) => runtime.recorder.note(text)}
          placing={placing}
          placeFrom={placeFrom}
          onCenter={(at) => (placeCenter.current = at)}
          onTap={aimPlacing}
          placedMark={
            placing === "heading" && placeAt
              ? { at: placeAt, headingRad: placeHeading, draft: true }
              : placed && !placing
                ? { ...placed, draft: false }
                : null
          }
        />
      </BlurTarget>
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

          {!placing && <RegionPrompt panelStyle={panel} />}

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
                    {t(placing === "position" ? "placeHint" : placeHeading === null ? "placeHeadingHint" : "placeHeadingConfirm")}
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
                  onPress={placing === "position" ? placeHere : finishPlacing}
                  // A placing always has a heading: Confirm waits for the first tap.
                  disabled={placing === "heading" && placeHeading === null}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: placing === "heading" && placeHeading === null }}
                  style={({ pressed }) => [
                    styles.ghostButton,
                    styles.answerButton,
                    { backgroundColor: palette.surface },
                    placing === "heading" && placeHeading === null && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <T w="semibold" size={14} color={palette.accent}>
                    {t(placing === "position" ? "placeHere" : "placeConfirm")}
                  </T>
                </Pressable>
              </View>
            </View>
          )}

          {!placing && !position?.poseQuestion && !manual && standing && lost && (
            <Pressable
              onPress={() => startPlacing()}
              style={({ pressed }) => [panel, styles.chip, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <GlassFill radius={Radius.pill} />
              <Icon name="location_on" size={16} color={palette.accent} />
              <T w="semibold" size={13} color={palette.accent}>
                {t("placeOffer")}
              </T>
            </Pressable>
          )}

          {!placing && manual && !manual.asking && (
            <View style={[panel, styles.chip, styles.manualChip]}>
              <GlassFill radius={Radius.pill} />
              <Pressable
                // Placing it again: only while the car stands, as the first time.
                onPress={standing ? () => startPlacing() : undefined}
                disabled={!standing}
                accessibilityRole="button"
                style={({ pressed }) => [styles.manualChipBody, pressed && styles.pressed]}
              >
                <Icon name="location_on" size={16} color={palette.accent} />
                <T w="semibold" size={13} color={palette.accent} numberOfLines={1}>
                  {t("manualChip").replace("{age}", manualAge)}
                </T>
              </Pressable>
              <Pressable
                onPress={() => forgetManual()}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t("manualForget")}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Icon name="close" size={16} color={palette.text2} />
              </Pressable>
            </View>
          )}

          {!placing && manual?.asking && (
            <View style={[panel, styles.alertCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.warn.a }]}>
                  <Icon name="location_on" size={20} color={palette.warn.c} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t("manualQuestion")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t("manualQuestionWhy").replace("{age}", manualAge)}
                  </T>
                </View>
              </View>
              <View style={styles.answerRow}>
                {([true, false] as const).map((here) => (
                  <Pressable
                    key={String(here)}
                    onPress={() => (here ? navigator.answerManual(true) : forgetManual(true))}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.ghostButton, styles.answerButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                  >
                    <T w="semibold" size={14} color={palette.accent}>
                      {t(here ? "manualYes" : "poseNo")}
                    </T>
                  </Pressable>
                ))}
              </View>
            </View>
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
            <View style={[panel, styles.chip]}>
              <GlassFill radius={Radius.pill} />
              <Icon name="bluetooth" size={16} color={palette.warn.c} />
              <T w="semibold" size={13} color={palette.warn.c}>
                {t("obdFindingProtocol")}
              </T>
            </View>
          )}

          {!placing && sinceTrusted && (
            <View style={[panel, styles.chip]}>
              <GlassFill radius={Radius.pill} />
              <Icon name="history" size={16} color={palette.text2} />
              <T w="medium" size={13} numberOfLines={1}>
                {sinceTrusted}
              </T>
            </View>
          )}

          {showCutGps && detailsOpen && (
            <Pressable
              onPress={() => navigator.setSimulatedOutage(true)}
              style={({ pressed }) => [panel, styles.chip, pressed && styles.pressed]}
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

          {route && (
            <RouteBanner route={route} nowMs={position?.timestamp ?? 0} onStop={stopRoute} muted={voiceMuted} onToggleVoice={voiceOff ? undefined : toggleVoice} offPhone={audioOutput.offPhone} />
          )}
        </View>

        {!position && !placing && (
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
          {held.destination && !placing && (
            <View style={[panel, styles.pinCard]}>
              <GlassFill radius={Radius.rL} />
              <View style={styles.alertRow}>
                <View style={[styles.alertIcon, { backgroundColor: palette.warn.a }]}>
                  <Icon name="alt_route" size={20} color={palette.warn.c} />
                </View>
                <View style={styles.alertText}>
                  <T w="semibold" size={15}>
                    {t("noAdapterRouteTitle")}
                  </T>
                  <T size={13} color={manual || trust === "TRUSTED" ? palette.ok.c : palette.text2}>
                    {manual
                      ? t("noAdapterRoutePositionSet").replace("{age}", manualAge)
                      : trust === "TRUSTED"
                        ? t("noAdapterRouteGps")
                        : t(mayPlace ? "noAdapterRouteSetPosition" : "noAdapterRouteStopToSet")}
                  </T>
                  <T size={13} color={palette.text2}>
                    {t("noAdapterRouteFollow")}
                  </T>
                </View>
                <Pressable
                  onPress={held.cancel}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t("cancel")}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Icon name="close" size={20} color={palette.text2} />
                </Pressable>
              </View>
              <View style={styles.pinActions}>
                {!manual && trust !== "TRUSTED" && mayPlace && (
                  <Pressable
                    onPress={() => startPlacing()}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                  >
                    <Icon name="location_on" size={16} color={palette.accent} />
                    <T w="semibold" size={15} color={palette.accent}>
                      {t("noAdapterRouteSetButton")}
                    </T>
                  </Pressable>
                )}
                <Pressable
                  onPress={held.confirm}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.accent }, pressed && styles.pressed]}
                >
                  <Icon name="navigation" size={16} color={palette.onAccent} />
                  <T w="semibold" size={15} color={palette.onAccent}>
                    {t("noAdapterRouteAgree")}
                  </T>
                </Pressable>
              </View>
            </View>
          )}
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
                <Pressable
                  onPress={() => setPin(null)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t("cancel")}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Icon name="close" size={20} color={palette.text2} />
                </Pressable>
              </View>
              <View style={styles.pinActions}>
                {mayPlace && (
                  <Pressable
                    // The car is here, not a destination: the same placing as from the chip, starting at the pin.
                    onPress={() => startPlacing(pin)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                  >
                    <Icon name="location_on" size={16} color={palette.accent} />
                    <T w="semibold" size={15} color={palette.accent}>
                      {t("placeMeHere")}
                    </T>
                  </Pressable>
                )}
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
              label={recording ? t("driving") : t("vehicle")}
              href="/vehicle"
              badge={linkBadge}
              badgeLabel={t(LINK_BADGE_LABEL[linkBadge])}
              highlight={recording}
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

/** "just now", "12 min ago", "1 h 5 min ago". */
function formatAge(ms: number, t: ReturnType<typeof useT>["t"]): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t("ageJustNow");
  if (min < 60) return t("ageMinutes").replace("{m}", String(min));
  return t("ageHours").replace("{h}", String(Math.floor(min / 60))).replace("{m}", String(min % 60));
}

/** Wall clock, ms, redrawn every `everyMs` while `on`. */
function useNowMs(on: boolean, everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
}

const LINK_BADGE_LABEL = { ok: "badgeOk", busy: "badgeBusy", bad: "badgeBad" } as const;

/** The vehicle button's connection dot; `pulse` (connecting) scales it up and down a little. */
function BadgeDot({ color, border, pulse, label }: { color: string; border: string; pulse: boolean; label?: string }) {
  const [scale] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!pulse) {
      scale.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.35, duration: 500, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, scale]);
  return (
    <Animated.View
      style={[styles.recDot, { backgroundColor: color, borderColor: border, transform: [{ scale }] }]}
      accessibilityLabel={label}
    />
  );
}

function HudAction({
  icon,
  label,
  href,
  badge,
  badgeLabel,
  highlight,
}: {
  icon: IconName;
  label: string;
  href: "/route" | "/vehicle" | "/more";
  /** Connection state dot: green ready, yellow connecting, red not connected. */
  badge?: LinkBadge;
  badgeLabel?: string;
  /** The label in the accent colour (a trip is recording). */
  highlight?: boolean;
}) {
  const palette = usePalette();
  const badgeColor = badge === "ok" ? palette.ok.c : badge === "busy" ? palette.warn.c : palette.bad.c;
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
            {badge && <BadgeDot color={badgeColor} border={palette.groupBg} pulse={badge === "busy"} label={badgeLabel} />}
            <T w="medium" size={12} color={highlight ? palette.accent : undefined}>
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
      <MapBlur intensity={40} />
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
  disabled: { opacity: 0.4 },
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
  manualChip: { maxWidth: "100%", paddingRight: 12, gap: 10 },
  manualChipBody: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  chip: {
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
