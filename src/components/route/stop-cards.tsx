import { router } from "expo-router";

import { CardActions, CardLine, HudCard, PillButton } from "@/components/map/hud-card";
import { formatDistance } from "@/components/status/format-geo";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { RouteSnapshot } from "@/services/navigation/route-service";
import { getRuntime } from "@/services/runtime";

import { formatArrival, formatDurationS } from "./guidance-text";
import { CATEGORY_ICON, CATEGORY_LABEL, detourText, placeDetail } from "./stop-text";

/** Where the trip goes after the stop it is at: the next stop, else the destination. */
function nextPoint(route: RouteSnapshot) {
  return route.stops[0] ?? route.destination;
}

/**
 * At a stop (STOPS-SPEC §5.2): what is next and when, "we'll go on once you drive off"; **End here** ends the route,
 * **Go on** the wait.
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

/** A stop left behind (STOPS-SPEC §5.3): going on to the next point; **Back to it · +n min** plans back through it. */
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
      {passed.backDeltaS !== null && (
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
 * A place before it becomes a stop (STOPS-SPEC §7.3): its detour, the time there and the new arrival, from the trip
 * through it; **Add stop** takes that trip, **Only here** makes it the destination.
 */
export function StopPreviewCard({ route, nowMs, onOnlyHere }: { route: RouteSnapshot; nowMs: number; onOnlyHere(): void }) {
  const { t } = useT();
  const palette = usePalette();
  const pv = route.preview!;
  const routes = getRuntime().routes;
  const category = pv.place.category;
  const at = pv.plan?.stops?.find((s) => s.key === pv.place.key);
  const lines =
    pv.status === "planning"
      ? t("stopPlanning")
      : pv.status === "failed" || !pv.plan || pv.deltaS === undefined
        ? t("stopNoWay")
        : [
            `${t("stopDetour")} ${detourText(pv.deltaS, t)}`,
            at ? `${t("stopThereAt")} ${formatArrival(at.atS, nowMs)}` : null,
            `${t("stopArrival")} ${formatArrival(pv.plan.durationS, nowMs)}`,
          ]
            .filter(Boolean)
            .join(" · ");
  const side = at?.side ?? null;
  const detail = category ? placeDetail({ category, flags: pv.place.flags ?? 0, hours: pv.place.hours }, side, t, nowMs) : "";
  return (
    <HudCard
      icon={category ? CATEGORY_ICON[category] : "place"}
      tone={{ a: palette.accentA, c: palette.accent }}
      title={pv.place.name ?? t("droppedPin")}
      onClose={() => routes.cancelPreview()}
      lines={
        <>
          {detail ? <CardLine>{category ? `${t(CATEGORY_LABEL[category])} · ${detail}` : detail}</CardLine> : null}
          <CardLine>{lines}</CardLine>
        </>
      }
    >
      <CardActions gap={10}>
        {category && (
          <PillButton
            icon="arrow_back"
            label={t(CATEGORY_LABEL[category])}
            onPress={() => {
              routes.cancelPreview();
              router.push({ pathname: "/along", params: { category } });
            }}
          />
        )}
        <PillButton icon="flag" label={t("stopOnlyHere")} onPress={onOnlyHere} />
        <PillButton icon="add" label={t("stopAddButton")} onPress={() => routes.confirmPreview()} primary />
      </CardActions>
    </HudCard>
  );
}
