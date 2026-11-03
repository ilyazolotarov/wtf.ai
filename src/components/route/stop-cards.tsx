import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { CardActions, CardLine, HudCard, PillButton, usePanelStyle } from "@/components/map/hud-card";
import { formatDistance } from "@/components/status/format-geo";
import { GlassFill } from "@/components/ui/glass-fill";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { getRuntime } from "@/services/runtime";

import { formatArrival, formatDurationS } from "./guidance-text";
import { UndoStrip } from "./save-feedback";
import { CATEGORY_ICON } from "./stop-text";
import { TRIP_UNDO_MS, tripUndo, type TripUndo } from "./trip-undo";

/** Where the trip goes after the stop it is at: the next stop, else the destination. */
function nextPoint(route: RouteSnapshot) {
  return route.stops[0] ?? route.destination;
}

/**
 * At a stop (STOPS-SPEC §5.2): what is next and when; **End route** ends the route, **Continue** the wait.
 */
export function AtStopCard({ route, nowMs, onEnd }: { route: RouteSnapshot; nowMs: number; onEnd(): void }) {
  const { t, language } = useT();
  const palette = usePalette();
  const g = route.guidance;
  const next = nextPoint(route);
  const toStop = g?.nextStop != null;
  const leftM = (toStop ? g?.toStopM : g?.remainingM) ?? 0;
  const leftS = (toStop ? g?.toStopS : g?.remainingS) ?? 0;
  return (
    <HudCard
      icon="flag"
      tone={palette.ok}
      title={`${t("stopNext")}: ${next.name ?? t("droppedPin")}`}
      lines={
        <>
          <CardLine>{`${formatDistance(leftM, language)} · ${formatDurationS(leftS, t)} · ${t("arriveAt").replace("{time}", formatArrival(leftS, nowMs))}`}</CardLine>
          <CardLine color={palette.ok.c}>{t("stopGoOnSoon")}</CardLine>
        </>
      }
    >
      <CardActions gap={10}>
        <PillButton icon="close" label={t("stopEndHere")} onPress={onEnd} />
        <PillButton icon="navigation" label={t("stopGoOn")} onPress={() => getRuntime().routes.goOn()} primary />
      </CardActions>
    </HudCard>
  );
}

/**
 * A stop left behind (STOPS-SPEC §5.3): going on to the next point; **Go back · +n min** plans back through it, while
 * the trip has room for it.
 */
export function PassedStopCard({ route }: { route: RouteSnapshot }) {
  const { t } = useT();
  const palette = usePalette();
  const passed = route.passedStop!;
  const routes = getRuntime().routes;
  const next = nextPoint(route);
  const name = passed.stop.name ?? t("droppedPin");
  return (
    <HudCard
      icon={passed.stop.category ? CATEGORY_ICON[passed.stop.category] : "flag"}
      tone={palette.warn}
      title={t("stopBehind").replace("{name}", name)}
      onClose={() => routes.dismissPassed()}
      lines={<CardLine>{t("stopGoingOn").replace("{name}", next.name ?? t("droppedPin"))}</CardLine>}
    >
      {passed.backDeltaS !== null && route.stops.length < routes.maxStops && (
        <CardActions gap={10}>
          <PillButton
            icon="u_turn_left"
            label={
              passed.backDeltaS === undefined
                ? t("stopBackPlanning")
                : t("stopBack").replace("{delta}", t("alongDetour").replace("{n}", String(Math.max(1, Math.round(passed.backDeltaS / 60)))))
            }
            onPress={() => routes.backToPassed()}
          />
        </CardActions>
      )}
    </HudCard>
  );
}

/**
 * A trip change made in one tap (STOPS-SPEC §7.4): what it did and **Undo**, counting down the seconds left; gone
 * after `TRIP_UNDO_MS` or on ✕. Keyed by the offer, so a new one counts from the start.
 */
export function TripUndoCard({ undo }: { undo: TripUndo }) {
  const { t } = useT();
  const panel = usePanelStyle();
  useEffect(() => {
    const timer = setTimeout(() => tripUndo.clear(undo.id), TRIP_UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo.id]);
  const name = undo.name ?? t("droppedPin");
  // The saved place's strip (save-feedback.tsx), on the map's glass.
  return (
    <View style={[panel, styles.glass]}>
      <GlassFill radius={Radius.rL} />
      <UndoStrip
        done
        icon={undo.kind === "stop" ? "check_circle" : "alt_route"}
        message={t(undo.kind === "stop" ? "tripUndoStop" : "tripUndoRoute").replace("{name}", name)}
        onUndo={() => tripUndo.take()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  glass: { borderRadius: Radius.rL, overflow: "hidden" },
});
