import { useMemo } from "react";

import { resultDetail, resultTitle } from "@/components/route/search-text";
import { cardinal, formatDistance, toDegrees } from "@/components/status/format-geo";
import { useAgeText } from "@/components/status/use-age-text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";
import { activeSearchIndex } from "@/services/offline-map/search-file";

import { CardActions, CardLine, HudCard, PillButton } from "./hud-card";
import { pinLevel, type Pin } from "./pin-pick";

/**
 * A pin dropped by a long press (ROUTING-SPEC §8): what is there at the zoom it was dropped at (`pin-pick.ts`: the
 * building, else the street under the finger, else the settlement; below z9 "Dropped pin"), its distance and
 * direction, **Route here** (to the pin's exact point, named so) and **I'm here** (`onPlace`: the placing from it).
 */
export function PinCard({
  pin,
  position,
  onClose,
  onPlace,
  onRoute,
}: {
  pin: Pin;
  position: PositionEstimate | null;
  onClose(): void;
  onPlace: (() => void) | undefined;
  /** `name`: what the pin is ("вулиця Шевченка, 10", a street, a town), for the route's banner. */
  onRoute(name: string | undefined): void;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  // The finest name the press can tell: a building, else its street, else its settlement.
  const named = useMemo((): { title: string; detail: string } | null => {
    const level = pinLevel(pin.pick?.zoom ?? 17);
    if (!level) return null;
    try {
      const index = activeSearchIndex();
      const town = index?.settlementAt(pin) ?? null;
      const house = level === "building" ? (index?.nearestAddress(pin) ?? null) : null;
      const street = level === "building" ? (pin.pick?.street ?? null) : null;
      // A house's detail is its settlement; one addressed by its quarter or village names none of its own.
      const houseNamed = house && {
        title: resultTitle(house, language, t),
        detail: house.settlement || !town ? resultDetail(house, language, t) : resultTitle(town, language, t),
      };
      const streetNamed = street && {
        title: language === "en" && street.nameEn ? street.nameEn : street.name,
        detail: town ? resultTitle(town, language, t) : "",
      };
      // On a building: that house. On a road or a yard: the street under the finger, else the house nearest.
      const named = pin.pick?.onBuilding === false ? (streetNamed ?? houseNamed) : (houseNamed ?? streetNamed);
      if (named) return named;
      return town ? { title: resultTitle(town, language, t), detail: resultDetail(town, language, t) } : null;
    } catch (e) {
      console.warn(`pin name: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [pin, language, t]);
  const title = named?.title ?? t("droppedPin");
  const where = position
    ? `${formatDistance(haversineM(position, pin), language)} · ${cardinal(toDegrees(bearingRad(position, pin)), language)}`
    : `${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`;
  return (
    <HudCard
      icon="place"
      tone={{ a: palette.accentA, c: palette.accent }}
      title={title}
      onClose={onClose}
      lines={<CardLine>{named?.detail ? `${named.detail} · ${where}` : where}</CardLine>}
    >
      <CardActions gap={10}>
        {onPlace && <PillButton icon="location_on" label={t("placeMeHere")} onPress={onPlace} />}
        <PillButton icon="alt_route" label={t("routeHere")} onPress={() => onRoute(named ? title : undefined)} primary />
      </CardActions>
    </HudCard>
  );
}

/**
 * A route asked for without an adapter waits for the driver's word (UI-SPEC §6.3): where the position comes from,
 * that the route must be followed exactly, **Set position** while the car stands, **I'll follow the route**.
 */
export function HeldRouteCard({
  manual,
  trusted,
  mayPlace,
  onPlace,
  onCancel,
  onConfirm,
}: {
  manual: PositionEstimate["manual"];
  trusted: boolean;
  mayPlace: boolean;
  onPlace(): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  const age = useAgeText(manual?.confirmedAt);
  return (
    <HudCard
      icon="alt_route"
      tone={palette.warn}
      title={t("noAdapterRouteTitle")}
      onClose={onCancel}
      lines={
        <>
          <CardLine color={manual || trusted ? palette.ok.c : undefined}>
            {manual
              ? t("noAdapterRoutePositionSet").replace("{age}", age)
              : trusted
                ? t("noAdapterRouteGps")
                : t(mayPlace ? "noAdapterRouteSetPosition" : "noAdapterRouteStopToSet")}
          </CardLine>
          <CardLine>{t("noAdapterRouteFollow")}</CardLine>
        </>
      }
    >
      <CardActions gap={10}>
        {!manual && !trusted && mayPlace && (
          <PillButton icon="location_on" label={t("noAdapterRouteSetButton")} onPress={onPlace} />
        )}
        <PillButton icon="navigation" label={t("noAdapterRouteAgree")} onPress={onConfirm} primary />
      </CardActions>
    </HudCard>
  );
}
