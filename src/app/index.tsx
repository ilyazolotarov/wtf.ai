import { useKeepAwake } from "expo-keep-awake";
import { router, useIsFocused } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BottomBar } from "@/components/map/bottom-bar";
import { CAMERA_BUTTON_SIZE, CameraButton } from "@/components/map/camera-button";
import { CameraCard } from "@/components/map/camera-card";
import { MAP_CREDIT_HEIGHT } from "@/components/map/map-credit";
import { NoFixCard, PermissionCard } from "@/components/map/center-cards";
import { HeldRouteCard, PinCard } from "@/components/map/destination-cards";
import { HudCard, HudChip, usePanelStyle } from "@/components/map/hud-card";
import { MapSurface } from "@/components/map/map-surface";
import { useMapTurn, type MapTurn } from "@/components/map/map-turn";
import type { Pin } from "@/components/map/pin-pick";
import { PlacingPin } from "@/components/map/placing-pin";
import { ManualChip, ManualQuestionCard, OnTheWayCard, PlacingCard, PoseQuestionCard } from "@/components/map/placing-cards";
import { RegionPrompt } from "@/components/map/region-prompt";
import { SheetBlur } from "@/components/map/sheet-blur";
import { StatusRow } from "@/components/map/status-row";
import { OutageCard, SinceTrustedStrip, TrustAlertCard, trustAlertText } from "@/components/map/trust-cards";
import { useCameraMode } from "@/components/map/use-camera-mode";
import { speedBesideCard } from "@/components/map/speed-alerts";
import { useSpeedAlerts } from "@/components/map/use-speed-alerts";
import { usePlaceReminder } from "@/components/map/use-place-reminder";
import { useCompassHeading, useHeadingUp, walkingCompass } from "@/components/map/use-compass-heading";
import { isLost, usePlacing } from "@/components/map/use-placing";
import { openLessons } from "@/components/guide/lesson-bodies";
import { LessonsInvite, MapTour, TourInvite, type TourTry } from "@/components/guide/map-tour";
import { RouteBanner } from "@/components/route/route-banner";
import { useAudioOutput } from "@/components/route/use-audio-output";
import { useVoiceGuidance, useVoiceMuted, useVoiceVolume } from "@/components/route/use-voice-guidance";
import { UpdatePrompts } from "@/components/update/update-prompts";
import { useNavStatus } from "@/components/status/use-nav-status";
import { useFirmwareNotice } from "@/components/vehicle/use-firmware-notice";
import { ANDROID_BLURS, BlurScope, BlurTarget } from "@/components/ui/glass-fill";
import { FontScaleLimit, MAP_MAX_FONT_SCALE, T } from "@/components/ui/text";
import { useHasUsableMap } from "@/config/map";
import { PanelMaxWidth, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { MOVING_MPS } from "@/services/app-update/decide";
import { usePositionPermission } from "@/providers/position-provider";
import { useHeldRoute, useRoute } from "@/providers/route-provider";
import { useDevSettings, useRecorderSnapshot, useRuntime } from "@/providers/runtime-provider";
import { isOnboardingDone, markWakeOffered } from "@/services/preferences";
import { wakeToOffer } from "@/components/vehicle/use-wake-setup";
import {
  dismissLessonsInvite,
  isLessonsInviteDue,
  isTourOffered,
  markTourOffered,
  onTourRequest,
  takeTourRequest,
} from "@/services/guide/guide-progress";

/**
 * The map turns with a phone held sideways where it is a view that can be rotated: iOS, and Android's TextureView
 * (12+, map-surface.native.tsx). A GLSurfaceView (Android 10–11) can't be: the map stays as the app is.
 */
const CAN_TURN_MAP = Platform.OS !== "android" || ANDROID_BLURS;

/**
 * The map's frame for a turn: the whole screen, turned about its centre; sideways, the screen's height wide and its
 * width high, so turned it fills the screen again.
 */
function mapFrame(turn: MapTurn, screen: { width: number; height: number }) {
  if (turn === 0) return StyleSheet.absoluteFill;
  const sideways = turn !== 180;
  const width = sideways ? screen.height : screen.width;
  const height = sideways ? screen.width : screen.height;
  return {
    position: "absolute" as const,
    width,
    height,
    left: (screen.width - width) / 2,
    top: (screen.height - height) / 2,
    transform: [{ rotate: `${turn}deg` }],
  };
}

/**
 * Where the map data credit shows, in the map's own frame: upright, above the bottom bar level with the camera button;
 * turned, where no panel covers it: the middle of the screen's side edge (sideways), the bottom left (upside down).
 */
function creditAt(turn: MapTurn, bottom: number) {
  if (turn === 0) return { bottom, left: 18 };
  if (turn === 180) return { top: bottom, right: 18 };
  return { bottom: OVERLAY_GUTTER, left: 0, right: 0 };
}

/** The walking compass for a phone held sideways: where the screen's top now points. */
function turnCompass<C extends { headingRad: number }>(compass: C | null, turn: MapTurn): C | null {
  return compass && turn ? { ...compass, headingRad: compass.headingRad + (turn * Math.PI) / 180 } : compass;
}

/** The map's panels from the screen's sides (and the side insets). */
const OVERLAY_GUTTER = 14;


export default function HomeScreen() {
  useKeepAwake();
  // A new adapter's first answer: ask the driver to check its firmware (VEHICLE-LINK-SPEC §8.4).
  useFirmwareNotice();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  // iOS: the bar may reach a little into the home indicator's strip. Android's bottom inset is its navigation bar (the
  // 3-button one is 48 dp of buttons): the bar stays above it, or its lower edge hid behind the buttons.
  const bottomPadding = Platform.OS === "android" ? insets.bottom + 8 : Math.max(insets.bottom - 6, 14);
  // The bottom bar's height, for the map data credit above it (UI-SPEC §6.1), level with the camera button: its centre is the bar, the stack's gap and half the button up from the bottom padding.
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
  const [pin, setPin] = useState<Pin | null>(null);
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
  // A phone held sideways turns the map, not the app (UI-SPEC §4.7).
  const turn = useMapTurn(CAN_TURN_MAP);
  // Not in a car (no trip, no adapter): the phone compass may stand in for heading. It gives where the phone's top
  // points; held sideways, the phone points where its side does.
  const compass = turnCompass(
    walkingCompass(position, useCompassHeading(!recording && nav.adapter !== "on" && position != null)),
    turn,
  );
  const headingUp = useHeadingUp(position, compass);
  const turnNoted = useRef(false);
  useEffect(() => {
    // Upright at mount is not a turn; back to upright after one is.
    if (turn === 0 && !turnNoted.current) return;
    turnNoted.current = true;
    runtime.recorder.note(`map turned ${turn}°`);
  }, [turn, runtime]);
  useVoiceGuidance(route, position?.speedMps, voiceMuted || voiceOff);
  const { speed, camera } = useSpeedAlerts();
  const audioOutput = useAudioOutput(route?.status === "active");

  // The map tour (UI-SPEC §7.7): offered once after the first map, or asked for from the Guide. Three of its stops
  // are tried for real on the map; which were, and the stop shown.
  const [touring, setTouring] = useState(false);
  const [tourTried, setTourTried] = useState<ReadonlySet<TourTry>>(new Set());
  const [tourStop, setTourStop] = useState<TourTry | null>(null);
  const [tourStep, setTourStep] = useState(0);
  const tryTour = (id: TourTry) => setTourTried((tried) => new Set([...tried, id]));

  const { cameraMode, setCameraMode, onGesture, toggleCameraMode: toggleMode, overview } = useCameraMode({
    recording,
    // A linger after engine off is still the same drive for the camera.
    onTrip: recording || recorderState === "lingering",
    speedMps: position?.speedMps,
    route,
    log: (text) => runtime.recorder.note(text),
  });
  // Tap never enters free (only map gestures do); from free it goes to heading-up.
  const toggleCameraMode = () => {
    setGhostView(false);
    toggleMode();
    if (touring) tryTour("follow");
  };

  const place = usePlacing({ position, navigator, setCameraMode, onStart: () => setPin(null) });
  const placing = place.step;
  // Lost while standing: offer putting the car on the map, and say so when the ignition comes on.
  const placeOffered = !placing && !position?.poseQuestion && !manual && place.standing && isLost(position);
  // Started on the way (iOS's wake): the parked pose was left aside until the car is found.
  const onTheWay = useSyncExternalStore(runtime.onTheWay.subscribe, runtime.onTheWay.get);
  usePlaceReminder({ offered: placeOffered, muted: voiceMuted || voiceOff });

  const ghost = trust === "UNTRUSTED" ? position?.rawGnss : undefined;
  const showingGhost = ghostView && ghost != null;
  const alertText = trustAlertText(nav, t);

  // The explanation under the status pill stays folded to leave room for the map; a tap on the pill opens it. The
  // last trusted fix's strip and the manual position's chip are part of it: the pill already says the position is
  // set by hand.
  const showCutGps = outageButton && position != null && !outage;
  const showManual = !placing && manual != null && !manual.asking;
  // On the tour's status stop the pill unfolds even with nothing to explain: then the tour says what it means.
  const tourStatus = touring && tourStop === "status";
  const hasDetails = outage != null || alertText != null || showCutGps || showManual || tourStatus;
  const [detailsToggled, setDetailsOpen] = useState(false);
  const detailsOpen = detailsToggled && hasDetails;

  const screenFocused = useIsFocused();
  const mapReady = useHasUsableMap();

  const [tourOffered, setTourOffered] = useState(isTourOffered);
  // The status stop's hole follows the top stack as it unfolds.
  const [tourLayout, setTourLayout] = useState(0);
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
    setCameraMode("follow");
    setTourTried(new Set());
    setTourStep(0);
    setTouring(true);
  };
  // Done (not skipped): the lessons' offer, which follows, is the tour's end too.
  const [tourFinished, setTourFinished] = useState(false);
  const endTour = (finished: boolean) => {
    setTourFinished(finished);
    // Its end is the lessons' offer, even when Not now hid it earlier in this run.
    if (finished) setLessonsDue(isLessonsInviteDue());
    setTouring(false);
    setTourStop(null);
    setPin(null);
    setDetailsOpen(false);
  };
  // Then the lessons (UI-SPEC §7.7): practice on drawn maps before the first drives, offered while the car stands.
  const [lessonsDue, setLessonsDue] = useState(isLessonsInviteDue);
  const answerLessons = (take: boolean) => {
    setLessonsDue(false);
    if (take) openLessons();
    else dismissLessonsInvite();
  };
  const showLessonsInvite =
    mapReady &&
    tourOffered &&
    lessonsDue &&
    !touring &&
    !pin &&
    !placing &&
    !position?.poseQuestion &&
    !held.destination &&
    !recording &&
    route == null &&
    (position?.speedMps ?? 0) <= MOVING_MPS;
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
    // Installed before the step that keeps the position without opening the app: shown once by itself, never on a drive.
    else if (recorderState !== "recording" && wakeToOffer()) {
      // Once, even if left with the back button.
      markWakeOffered();
      router.push({ pathname: "/onboarding", params: { only: "wake" } });
    }
  }, [screenFocused, mapReady, recorderState]);

  return (
    <BlurScope>
      <View style={[styles.root, { backgroundColor: palette.bg }]}>
        <BlurTarget>
          <View style={mapFrame(turn, window)}>
            <MapSurface
              mode={cameraMode}
              ghostView={showingGhost}
              compass={compass}
              headingUpRad={headingUp}
              onUserInteraction={onGesture}
              onLongPress={(at, pick) => {
                setPin({ ...at, pick });
                if (touring) tryTour("hold");
              }}
              pin={placing ? null : pin}
              logCamera={(text) => runtime.recorder.note(text)}
              placing={placing}
              placeFrom={place.placeFrom}
              onCenter={place.setCenter}
              onTap={place.aim}
              overview={overview}
              creditAt={creditAt(turn, cameraCentre - MAP_CREDIT_HEIGHT / 2)}
              placedMark={place.mark}
            />
          </View>
        </BlurTarget>
        {/* Its point on the map's centre, the spot placed: the lesson's pin (placing-pin.tsx). */}
        {placing === "position" && <PlacingPin />}
        <FontScaleLimit max={MAP_MAX_FONT_SCALE}>
          <View
            pointerEvents="box-none"
            style={[
              styles.overlay,
              // Sideways (landscape, a tablet ignoring the portrait lock) the navigation bar and cutouts are at the sides.
              {
                // Just under the status bar: its inset (time, signal, the camera cutout) is never covered, and only a
                // shadow's width more is kept, so the map gets the rest.
                paddingTop: insets.top + 2,
                paddingBottom: bottomPadding,
                paddingLeft: insets.left + OVERLAY_GUTTER,
                paddingRight: insets.right + OVERLAY_GUTTER,
              },
            ]}
          >
            <View
              ref={statusRef}
              pointerEvents="box-none"
              style={styles.topStack}
              onLayout={touring ? () => setTourLayout((n) => n + 1) : undefined}
            >
              <StatusRow
                nav={nav}
                // Beside the camera's card (not while placing), its sign the one on the screen (UI-SPEC §6.5).
                speed={placing ? speed : speedBesideCard(speed, camera)}
                expandable={hasDetails}
                expanded={detailsOpen}
                onToggle={() => {
                  setDetailsOpen((open) => !open);
                  if (tourStatus) tryTour("status");
                }}
              />

              {tourStatus && detailsOpen && !alertText && !outage && (
                <HudCard icon={nav.icon} tone={nav.color} lines={<T size={14} style={styles.tourExplain}>{t("tourStatusExplain")}</T>} />
              )}

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

              {placeOffered && (
                <HudChip icon="location_on" label={t("placeOffer")} color={palette.accent} onPress={() => place.start()} />
              )}

              {showManual && detailsOpen && (
                <ManualChip
                  manual={manual}
                  onPlace={() => place.start()}
                  onForget={() => place.forgetManual()}
                />
              )}

              {!placing && manual?.asking && (
                <ManualQuestionCard
                  manual={manual}
                  onAnswer={(here) => (here ? navigator.answerManual(true) : place.forgetManual(true))}
                />
              )}

              {!placing && onTheWay && <OnTheWayCard onClose={() => runtime.onTheWay.clear()} />}

              {!placing && position?.poseQuestion && (
                <PoseQuestionCard
                  distanceM={position.poseQuestion.distanceM}
                  onAnswer={(here) => {
                    navigator.answerPose(here);
                    // Not there: show where it is instead.
                    if (!here) place.start();
                  }}
                />
              )}

              {nav.protocolSearch && (
                <HudChip icon="bluetooth" label={t("obdFindingProtocol")} color={palette.warn.c} />
              )}

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

              {/* Unfolded only: driving, it took a line of the map under the pill. */}
              {!placing && position && detailsOpen && <SinceTrustedStrip position={position} />}

              {route && (
                <RouteBanner route={route} nowMs={position?.timestamp ?? 0} onStop={stopRoute} muted={voiceMuted} onToggleVoice={voiceOff ? undefined : toggleVoice} offPhone={audioOutput.offPhone} />
              )}

              {camera && !placing && <CameraCard camera={camera} />}
            </View>

            {!position && !placing && (permission != null && !permission.granted ? <PermissionCard /> : <NoFixCard onPlace={() => place.start()} />)}

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
              {/* On the tour the pin is only tried: its card would sit under the dimmed screen. */}
              {pin && !touring && (
                <PinCard
                  pin={pin}
                  position={position}
                  onClose={() => setPin(null)}
                  // The car is here, not a destination: the same placing as from the chip, starting at the pin.
                  onPlace={place.mayPlace ? () => place.start(pin) : undefined}
                  onRoute={(name) => {
                    startRoute({ lat: pin.lat, lon: pin.lon, name });
                    setPin(null);
                  }}
                />
              )}
              {mapReady && !tourOffered && !touring && !pin && !placing && !position?.poseQuestion && (
                <TourInvite panelStyle={panel} onStart={() => answerTour(true)} onDismiss={() => answerTour(false)} />
              )}
              {showLessonsInvite && (
                <LessonsInvite panelStyle={panel} afterTour={tourFinished} onStart={() => answerLessons(true)} onDismiss={() => answerLessons(false)} />
              )}
              <CameraButton ref={followRef} mode={cameraMode} onPress={toggleCameraMode} />
              <BottomBar ref={toolbarRef} recording={recording} onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)} />
            </View>
          </View>
          {/* Asked for from the Guide, it waits for the pages to close. */}
          {touring && screenFocused && (
            <MapTour
              targets={tourTargets}
              step={tourStep}
              onStep={setTourStep}
              layoutVersion={tourLayout}
              tried={tourTried}
              onStop={(id) => {
                setTourStop(id);
                // A pin tried on the press-and-hold stop goes with it, and the status folds once past its stop.
                if (id !== "hold") setPin(null);
                if (id !== "status") setDetailsOpen(false);
              }}
              onClose={endTour}
            />
          )}
          {/* Update prompts only while nothing else goes on (docs/UPDATES-SPEC.md §5.3). */}
          <UpdatePrompts
            busy={
              recording ||
              route != null ||
              nav.adapter === "on" ||
              (position?.speedMps ?? 0) > MOVING_MPS ||
              !screenFocused ||
              !mapReady ||
              touring ||
              !tourOffered ||
              showLessonsInvite ||
              pin != null ||
              placing != null
            }
          />
        </FontScaleLimit>
        <SheetBlur />
      </View>
    </BlurScope>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
  },
  // A tablet's wide window: the panels keep a phone's width, centred, and the map shows around them (PanelMaxWidth).
  topStack: { gap: 10, width: "100%", maxWidth: PanelMaxWidth, alignSelf: "center" },
  tourExplain: { lineHeight: 20 },
  bottomStack: { gap: 12, width: "100%", maxWidth: PanelMaxWidth, alignSelf: "center" },
});
