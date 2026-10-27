import { MapSurface } from "@/components/map/map-surface";
import { useHeadingUp } from "@/components/map/use-compass-heading";
import { I18nProvider } from "@/i18n/provider";
import { PositionProvider, usePosition } from "@/providers/position-provider";

/** The part of the car's screen under Android Auto's cards and buttons, in dp from each edge. */
export interface CarInsets {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface CarMapProps {
  /** The car's night mode (its own, not the phone's). */
  dark?: boolean;
  insets?: CarInsets;
  /** The map drawn this many times the car's density (CarMapSurface): bigger, as Android for Cars asks. */
  scale?: number;
}

/**
 * The car's map (docs/ANDROID-AUTO-SPEC.md §4): the React root `CarMap` (index.ts), which modules/android-auto mounts on
 * the car's screen while it shows the app, on the same JS runtime and services as the phone's screens. The phone's map,
 * heading-up and following the car in the part of the screen the template leaves free. What it shows of the route
 * besides the map, and the navigator kept running, are the car session's (car-session-task.ts).
 */
export function CarMapRoot({ dark = false, insets = {}, scale = 1 }: CarMapProps) {
  return (
    <I18nProvider>
      {/* The session runs the navigator: this map only draws it. */}
      <PositionProvider gnss={false}>
        <CarMap dark={dark} insets={insets} scale={scale} />
      </PositionProvider>
    </I18nProvider>
  );
}

const noop = () => {};

/**
 * Heading-up puts the dot this far down the car's visible map (the phone: 0.8 of its whole map): a car's screen is
 * wide and short, and the road ahead needs its height. Google Maps keeps its arrow lower still (about 0.92 on the head
 * unit), flat; tilted, the top already reaches far ahead.
 */
const CAR_HEADING_UP_DOT_AT = 0.85;

function CarMap({ dark, insets, scale }: Required<CarMapProps>) {
  const position = usePosition();
  const headingUp = useHeadingUp(position, null);
  const padding = {
    left: Math.round(insets.left ?? 0),
    top: Math.round(insets.top ?? 0),
    right: Math.round(insets.right ?? 0),
    bottom: Math.round(insets.bottom ?? 0),
  };
  return (
    <MapSurface
      mode="follow-heading"
      ghostView={false}
      compass={null}
      headingUpRad={headingUp}
      onUserInteraction={noop}
      onLongPress={noop}
      pin={null}
      scheme={dark ? "dark" : "light"}
      insets={padding}
      onOwnScreen
      carScale={scale}
      headingUpDotAt={CAR_HEADING_UP_DOT_AT}
      attributionPosition={{ bottom: padding.bottom + 8, left: padding.left + 8 }}
    />
  );
}
