import { Fragment, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { ExplainCard, LessonIntro, PulseRing } from "@/components/guide/lesson-ui";
import { sayFirstInstruction } from "@/components/guide/lesson-voice-sample";
import { MapCard, MapCardHeader, MapChipButton } from "@/components/guide/map-ui";
import { MiniMap, PinDot, Puck, RouteLine, useNudgedHeading } from "@/components/guide/mini-map";
import { BLOCKS, CAR, H, PARKS, PLACES, plan, roadHeadingDeg, roads, toCoordinate, TOP, W, type Planned, type Point } from "@/components/guide/route-map";
import { RouteBanner } from "@/components/route/route-banner";
import { hushVoice } from "@/components/route/voice-player";
import { Segmented } from "@/components/screens/screen-ui";
import { cardinal, formatDistance, toDegrees } from "@/components/status/format-geo";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM } from "@/nav/geo";
import { RoadClass } from "@/nav/mapmatch/graph/format";

type Tab = "hold" | "search";

/** Lesson 7: a route to anywhere, by a long press or a search (ROUTING-SPEC §8, UI-SPEC §7.1), planned for real. */
export function LessonRoute() {
  const { t, language } = useT();
  const palette = usePalette();
  const [tab, setTab] = useState<Tab>("hold");
  const [scale, setScale] = useState(1);
  const [dot, setDot] = useState<Point>(CAR);
  // Along the road the dot is on (or nearest to, set on the map off the roads).
  const heading = useNudgedHeading(roadHeadingDeg(dot));
  const [placed, setPlaced] = useState(false);
  const [pin, setPin] = useState<Point | null>(null);
  const [chosen, setChosen] = useState<(typeof PLACES)[number] | null>(null);
  const [route, setRoute] = useState<Planned | null>(null);
  const [muted, setMuted] = useState(false);
  const [plans, setPlans] = useState(0);

  // Leaving the lesson ends what its route was saying.
  useEffect(() => () => hushVoice(), []);

  const routeTo = (to: Point) => {
    const planned = plan(dot, to, !placed, plans + 1);
    setRoute(planned);
    setPlans(plans + 1);
    setPin(to);
    // As guidance starts: the first instruction, in the driver's voice volume.
    if (!muted) sayFirstInstruction(planned.snapshot.maneuvers, t, language);
  };
  const stopRoute = () => {
    hushVoice();
    setRoute(null);
    setPin(null);
    setChosen(null);
  };
  const searching = tab === "search" && !route;
  const fromDot = (to: Point) => {
    const a = toCoordinate(dot);
    const b = toCoordinate(to);
    return `${formatDistance(haversineM(a, b), language)} · ${cardinal(toDegrees(bearingRad(a, b)), language)}`;
  };

  return (
    <>
      <LessonIntro>{t("routeIntro")}</LessonIntro>
      <Segmented<Tab>
        value={tab}
        onChange={(value) => {
          setTab(value);
          stopRoute();
        }}
        options={[
          { value: "hold", label: t("routeTabHold") },
          { value: "search", label: t("routeTabSearch") },
        ]}
      />
      <MiniMap
        width={W}
        height={H}
        parks={PARKS}
        blocks={BLOCKS}
        minor={roads(RoadClass.residential)}
        major={roads(RoadClass.primary)}
        onLayout={(event) => setScale(event.nativeEvent.layout.width / W)}
        overlay={
          <>
            {!searching && (
              <Pressable
                style={StyleSheet.absoluteFill}
                onLongPress={(event) => {
                  setRoute(null);
                  setPin({ x: event.nativeEvent.locationX / scale, y: event.nativeEvent.locationY / scale });
                }}
                delayLongPress={400}
                accessibilityRole="button"
                accessibilityLabel={t("routeHoldHint")}
              />
            )}
            {!searching && !pin && !route && (
              <>
                <PulseRing left={`${(280 / W) * 100}%`} top={`${((TOP + 150) / H) * 100}%`} />
                <View pointerEvents="none" style={[styles.hint, placed && styles.hintBelowChip, { backgroundColor: palette.text }]}>
                  <T w="medium" size={13} color={palette.bg}>
                    {t("routeHoldHint")}
                  </T>
                </View>
              </>
            )}
            {placed && !route && (
              <MapChipButton
                icon="location_on"
                label={t("manualChip").replace("{age}", t("ageJustNow"))}
                onClose={() => {
                  setDot(CAR);
                  setPlaced(false);
                }}
                closeLabel={t("manualForget")}
                style={styles.chip}
              />
            )}

            {pin && !route && !searching && (
              <MapCard style={styles.bottom}>
                <MapCardHeader icon="place" title={t("droppedPin")} body={fromDot(pin)} onClose={() => setPin(null)} closeLabel={t("cancel")} />
                <View style={styles.pinActions}>
                  <Pressable
                    // As the map: "I'm here" puts the car where the pin is.
                    onPress={() => {
                      setDot(pin);
                      setPlaced(true);
                      setPin(null);
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.surface }, pressed && styles.pressed]}
                  >
                    <Icon name="location_on" size={16} color={palette.accent} />
                    <T w="semibold" size={15} color={palette.accent}>
                      {t("placeMeHere")}
                    </T>
                  </Pressable>
                  <Pressable
                    onPress={() => routeTo(pin)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.pinButton, { backgroundColor: palette.accent }, pressed && styles.pressed]}
                  >
                    <Icon name="alt_route" size={16} color={palette.onAccent} />
                    <T w="semibold" size={15} color={palette.onAccent}>
                      {t("routeHere")}
                    </T>
                  </Pressable>
                </View>
              </MapCard>
            )}

            {route && (
              <View style={styles.banner}>
                <RouteBanner
                  route={route.snapshot}
                  nowMs={route.nowMs}
                  onStop={stopRoute}
                  muted={muted}
                  onToggleVoice={() => {
                    if (!muted) hushVoice();
                    setMuted(!muted);
                  }}
                />
              </View>
            )}

            {searching && (
              <View style={[styles.search, { backgroundColor: palette.sheetBg }]}>
                <View style={[styles.field, { backgroundColor: palette.groupBg }]}>
                  <Icon name="search" size={16} color={palette.text2} />
                  <T size={15} color={palette.text2} numberOfLines={1}>
                    {t("searchPlaces")}
                  </T>
                </View>
                <View style={[styles.list, { backgroundColor: palette.groupBg }]}>
                  {PLACES.map((place, i) => (
                    <Fragment key={place.name}>
                      {i > 0 && <View style={[styles.line, { backgroundColor: palette.line }]} />}
                      <Pressable
                        onPress={() => setChosen(place)}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.place, pressed && styles.pressed]}
                      >
                        <View style={[styles.placeIcon, { backgroundColor: palette.accentA }]}>
                          <Icon name={place.icon} size={16} color={palette.accent} />
                        </View>
                        <T w="medium" size={15}>
                          {t(place.name)}
                        </T>
                      </Pressable>
                    </Fragment>
                  ))}
                </View>
                <T size={13} color={palette.text2} style={styles.note}>
                  {t("routeSearchMore")}
                </T>
                {chosen && (
                  <View style={[styles.summary, { backgroundColor: palette.groupBg, boxShadow: palette.cardShadow }]}>
                    <T w="semibold" size={17}>
                      {t(chosen.name)}
                    </T>
                    <T size={13} color={palette.text2}>
                      {fromDot(chosen.at)}
                    </T>
                    <Pressable
                      onPress={() => routeTo(chosen.at)}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.start, { backgroundColor: palette.accent }, pressed && styles.pressed]}
                    >
                      <T w="semibold" size={15} color={palette.onAccent}>
                        {t("startGuidance")}
                      </T>
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </>
        }
      >
        {route?.path ? <RouteLine d={route.path} /> : null}
        {/* As the map: a dropped pin's dot, then the destination's once the route goes there. */}
        {pin && <PinDot x={pin.x} y={pin.y} destination={route != null} />}
        <Puck x={dot.x} y={dot.y} r={12} headingDeg={heading} />
      </MiniMap>

      <ExplainCard
        rows={[
          { label: t("routeNoGpsLabel"), text: t("routeNoGps") },
          { label: t("routeWrongTurnLabel"), text: t("routeWrongTurn") },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hint: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: Radius.pill,
  },
  chip: { top: 10, left: 10 },
  // Under the "Position set manually" chip, not over it.
  hintBelowChip: { top: 56 },
  bottom: { bottom: 10 },
  banner: { position: "absolute", left: 10, right: 10, top: 10 },
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
  pressed: { opacity: 0.75 },
  search: { ...StyleSheet.absoluteFill, padding: 14, gap: 12 },
  field: { height: 44, borderRadius: Radius.pill, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  list: { borderRadius: 20, paddingHorizontal: 12 },
  line: { height: StyleSheet.hairlineWidth },
  place: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12 },
  placeIcon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  note: { lineHeight: 18, paddingHorizontal: 4 },
  summary: { position: "absolute", left: 10, right: 10, bottom: 10, borderRadius: Radius.rL, padding: 16, gap: 10 },
  start: { height: 46, borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
});
