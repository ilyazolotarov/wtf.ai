import { cardinal, formatDistance, toDegrees } from "@/components/status/format-geo";
import { useAgeText } from "@/components/status/use-age-text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { bearingRad, haversineM, type Coordinate } from "@/nav/geo";
import type { PositionEstimate } from "@/nav/position/types";

import { CardActions, CardLine, HudCard, PillButton } from "./hud-card";

/**
 * A pin dropped by a long press (ROUTING-SPEC §8): its distance and direction, **Route here**, and while the car
 * stands **I'm here** (`onPlace`: the placing, starting at the pin).
 */
export function PinCard({
  pin,
  position,
  onClose,
  onPlace,
  onRoute,
}: {
  pin: Coordinate;
  position: PositionEstimate | null;
  onClose(): void;
  onPlace: (() => void) | undefined;
  onRoute(): void;
}) {
  const { t, language } = useT();
  const palette = usePalette();
  return (
    <HudCard
      icon="place"
      tone={{ a: palette.accentA, c: palette.accent }}
      title={t("droppedPin")}
      onClose={onClose}
      lines={
        <CardLine>
          {position
            ? `${formatDistance(haversineM(position, pin), language)} · ${cardinal(toDegrees(bearingRad(position, pin)), language)}`
            : `${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`}
        </CardLine>
      }
    >
      <CardActions gap={10}>
        {onPlace && <PillButton icon="location_on" label={t("placeMeHere")} onPress={onPlace} />}
        <PillButton icon="alt_route" label={t("routeHere")} onPress={onRoute} primary />
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
