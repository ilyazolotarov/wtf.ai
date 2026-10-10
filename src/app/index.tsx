import { useKeepAwake } from "expo-keep-awake";
import { router, useIsFocused } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BottomBar } from "@/components/map/bottom-bar";
import { CAMERA_BUTTON_SIZE, CameraButton } from "@/components/map/camera-button";
import { NoFixCard, PermissionCard } from "@/components/map/center-cards";
import { HeldRouteCard, PinCard } from "@/components/map/destination-cards";
import { HudChip, usePanelStyle } from "@/components/map/hud-card";
import { MapSurface } from "@/components/map/map-surface";
import { ManualChip, ManualQuestionCard, PlacingCard, PoseQuestionCard } from "@/components/map/placing-cards";
import { RegionPrompt } from "@/components/map/region-prompt";
import { SheetBlur } from "@/components/map/sheet-blur";
import { StatusRow } from "@/components/map/status-row";
import { OutageCard, SinceTrustedStrip, TrustAlertCard, trustAlertText } from "@/components/map/trust-cards";
import { useCameraMode } from "@/components/map/use-camera-mode";
import { useCompassHeading, useHeadingUp, walkingCompass } from "@/components/map/use-compass-heading";
import { isLost, usePlacing } from "@/components/map/use-placing";
import { MapTour, TourInvite } from "@/components/guide/map-tour";
import { RouteBanner } from "@/components/route/route-banner";
import { useAudioOutput } from "@/components/route/use-audio-output";
import { useVoiceGuidance, useVoiceMuted, useVoiceVolume } from "@/components/route/use-voice-guidance";
import { useNavStatus } from "@/components/status/use-nav-status";
import { Icon } from "@/components/ui/icon";
import { BlurTarget } from "@/components/ui/glass-fill";
import { useHasUsableMap } from "@/config/map";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { Coordinate } from "@/nav/geo";
import { usePositionPermission } from "@/providers/position-provider";
import { useHeldRoute, useRoute } from "@/providers/route-provider";
import { useDevSettings, useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";
import { isOnboardingDone } from "@/services/preferences";
import { isTourOffered, markTourOffered, onTourRequest, takeTourRequest } from "@/services/guide/guide-progress";

/** MapLibre's attribution (i) button: a system info button on iOS (22 pt), the SDK's icon on Android (24 dp). */
const ATTRIBUTION_BUTTON = Platform.OS === "ios" ? 22 : 24;
/** iOS MapLibre places its ornaments from the safe area, not the screen's edge: the home indicator inset is already in. */
const ATTRIBUTION_INSET = (bottomInset: number) => (Platform.OS === "ios" ? bottomInset : 0);

export default function HomeScreen() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const bottomPadding = Math.max(insets.bottom - 6, 14);
  // The bottom bar's height, for MapLibre's attribution button above it (OSM credit, UI-SPEC §6.1), level with the
  // camera button: its centre is the bar, the stack's gap and half the button up from the bottom padding.
  const [barHeight, setBarHeight] = useState(72);
  const cameraCentre = bottomPadding + barHeight + styles.bottomStack.gap + CAMERA_BUTTON_SIZE / 2;
  const { t } = useT();
  const palette = usePalette();
  const panel = usePanelStyle();
  const nav = useNavStatus();
  const { position, trust } = nav;
  const { permission } = usePositionPermission();
  const { route, startRoute, stopRoute } = useRoute();
  // A route asked for without an adapter waits here for the driver's word (UI-SPEC §6.3).
  const held = useHeldRoute();
  // A long press on the map drops a pin to route to (ROUTING-SPEC §8), or to say the car is there.
  const [pin, setPin] = useState<Coordinate | null>(null);
  const [voiceMuted, toggleVoice] = useVoiceMuted();
  // Volume 0 in Settings: no voice, and no button for it.
  const voiceOff = useVoiceVolume() === 0;
  const [ghostView, setGhostView] = useState(false);
  const recorderState = useRecorderSnapshot().state;
  const { outageButton } = useDevSettings();
  const runtime = useRuntime();
  const { position: navigator } = runtime;
  const outage = position?.simulatedOutage;
  const manual = position?.manual;
  const recording = recorderState === "recording";
  // Not in a car (no trip, no adapter): the phone compass may stand in for heading.
  const compass = walkingCompass(
    position,
    useCompassHeading(!recording && nav.adapter !== "on" && position != null),
  );
  const headingUp = useHeadingUp(position, compass);
  useVoiceGuidance(route, position?.speedMps, voiceMuted || voiceOff);
  const audioOutput = useAudioOutput(route?.status === "active");

  const { cameraMode, setCameraMode, pickCameraMode, overview } = useCameraMode({
    recording,
    // A linger after engine off is still the same drive for the camera.
    onTrip: recording || recorderState === "lingering",
    speedMps: position?.speedMps,
    route,
  });
  // Tap never enters free (only map gestures do); from free it returns to follow.
  const toggleCameraMode = () => {
    setGhostView(false);
    pickCameraMode((mode) => (mode === "follow" ? "follow-heading" : "follow"));
  };

  const place = usePlacing({ position, navigator, pickCameraMode, setCameraMode, onStart: () => setPin(null) });
  const placing = place.step;

  const ghost = trust === "UNTRUSTED" ? position?.rawGnss : undefined;
  const showingGhost = ghostView && ghost != null;
  const alertText = trustAlertText(nav, t);

  // The explanation under the status pill stays folded to leave room for the map; a tap on the
  // pill opens it.
  const showCutGps = outageButton && position != null && !outage;
  const hasDetails = outage != null || alertText != null || showCutGps;
  const [detailsToggled, setDetailsOpen] = useState(false);
  const detailsOpen = detailsToggled && hasDetails;

  const screenFocused = useIsFocused();
  const mapReady = useHasUsableMap();

  // The map tour (UI-SPEC §7.7): offered once after the first map, or asked for from the Guide.
  const [touring, setTouring] = useState(false);
  const [tourOffered, setTourOffered] = useState(isTourOffered);
  const statusRef = useRef<View>(null);
  const followRef = useRef<View>(null);
  const toolbarRef = useRef<View>(null);
  const [tourTargets] = useState(() => ({ status: statusRef, follow: followRef, toolbar: toolbarRef }));
  const answerTour = (take: boolean) => {
    markTourOffered();
    setTourOffered(true);
    if (!take) return;
    // The dot's stop is the screen centre, where the follow camera keeps the car.
    setPin(null);
    setDetailsOpen(false);
    pickCameraMode(() => "follow");
    setTouring(true);
  };
  const takeTour = useEffectEvent(() => {
    if (takeTourRequest()) answerTour(true);
  });
  // The map stays mounted under the Guide page, so the request always comes while subscribed.
  useEffect(() => onTourRequest(() => takeTour()), []);
  // First run: onboarding, then a map to download. Each time the map is back on top (the
  // last region deleted, say), it asks again: the app has no online map.
  useEffect(() => {
    if (!screenFocused) return;
    if (!isOnboardingDone()) router.push("/onboarding");
    else if (!mapReady) router.push("/map-setup");
  }, [screenFocused, mapReady]);

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
          placeFrom={place.placeFrom}
          onCenter={place.setCenter}
          onTap={place.aim}
          overview={overview}
          attributionBottom={cameraCentre - ATTRIBUTION_BUTTON / 2 - ATTRIBUTION_INSET(insets.bottom)}
          placedMark={place.mark}
        />
      </BlurTarget>
      {placing === "position" && (
        <View pointerEvents="none" style={styles.placeTarget}>
          <Icon name="location_on" size={44} color={palette.accent} />
        </View>
      )}
      <View
        pointerEvents="box-none"
        style={[styles.overlay, { paddingTop: insets.top + 10, paddingBottom: bottomPadding }]}
      >
        <View pointerEvents="box-none" style={styles.topStack}>
          <StatusRow
            ref={statusRef}
            nav={nav}
            expandable={hasDetails}
            expanded={detailsOpen}
            onToggle={() => setDetailsOpen((open) => !open)}
          />

          {outage && detailsOpen && (
            <OutageCard outage={outage} nowMs={position.timestamp} onRestore={() => navigator.setSimulatedOutage(false)} />
          )}

          {!placing && <RegionPrompt panelStyle={panel} />}

          {placing && (
            <PlacingCard
              step={placing}
              hasHeading={place.hasHeading}
              onCancel={place.stop}
              onNext={placing === "position" ? place.placeHere : place.finish}
            />
          )}

          {!placing && !position?.poseQuestion && !manual && place.standing && isLost(position) && (
            <HudChip icon="location_on" label={t("placeOffer")} color={palette.accent} onPress={() => place.start()} />
          )}

          {!placing && manual && !manual.asking && (
            <ManualChip
              manual={manual}
              onPlace={place.standing ? () => place.start() : undefined}
              onForget={() => place.forgetManual()}
            />
          )}

          {!placing && manual?.asking && (
            <ManualQuestionCard
              manual={manual}
              onAnswer={(here) => (here ? navigator.answerManual(true) : place.forgetManual(true))}
            />
          )}

          {!placing && position?.poseQuestion && (
            <PoseQuestionCard
              distanceM={position.poseQuestion.distanceM}
              onAnswer={(here) => {
                navigator.answerPose(here);
                // Not there: show where it is instead, if it stands.
                if (!here && place.standing) place.start();
              }}
            />
          )}

          {nav.protocolSearch && (
            <HudChip icon="bluetooth" label={t("obdFindingProtocol")} color={palette.warn.c} />
          )}

          {!placing && position && <SinceTrustedStrip position={position} />}

          {showCutGps && detailsOpen && (
            <HudChip
              icon="gps_off"
              label={t("cutGps")}
              color={palette.accent}
              onPress={() => navigator.setSimulatedOutage(true)}
            />
          )}

          {alertText && !outage && detailsOpen && (
            <TrustAlertCard
              nav={nav}
              text={alertText}
              ghost={ghost}
              showingGhost={showingGhost}
              onToggleGhost={() => setGhostView(!showingGhost)}
            />
          )}

          {route && (
            <RouteBanner route={route} nowMs={position?.timestamp ?? 0} onStop={stopRoute} muted={voiceMuted} onToggleVoice={voiceOff ? undefined : toggleVoice} offPhone={audioOutput.offPhone} />
          )}
        </View>

        {!position && !placing && (permission != null && !permission.granted ? <PermissionCard /> : <NoFixCard />)}

        <View pointerEvents="box-none" style={styles.bottomStack}>
          {held.destination && !placing && (
            <HeldRouteCard
              manual={manual}
              trusted={trust === "TRUSTED"}
              mayPlace={place.mayPlace}
              onPlace={() => place.start()}
              onCancel={held.cancel}
              onConfirm={held.confirm}
            />
          )}
          {pin && (
            <PinCard
              pin={pin}
              position={position}
              onClose={() => setPin(null)}
              // The car is here, not a destination: the same placing as from the chip, starting at the pin.
              onPlace={place.mayPlace ? () => place.start(pin) : undefined}
              onRoute={() => {
                startRoute({ lat: pin.lat, lon: pin.lon });
                setPin(null);
              }}
            />
          )}
          {mapReady && !tourOffered && !touring && !pin && !placing && !position?.poseQuestion && (
            <TourInvite panelStyle={panel} onStart={() => answerTour(true)} onDismiss={() => answerTour(false)} />
          )}
          <CameraButton ref={followRef} mode={cameraMode} onPress={toggleCameraMode} />
          <BottomBar ref={toolbarRef} recording={recording} onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} />
        </View>
      </View>
      {/* Asked for from the Guide, it waits for the pages to close. */}
      {touring && screenFocused && <MapTour targets={tourTargets} onClose={() => setTouring(false)} />}
      <SheetBlur />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    paddingHorizontal: 14,
  },
  topStack: { gap: 10 },
  // The pin's tip on the map centre: the icon is 44 high, its tip at the bottom.
  placeTarget: { position: "absolute", left: "50%", top: "50%", marginLeft: -22, marginTop: -40 },
  bottomStack: { gap: 12 },
});
