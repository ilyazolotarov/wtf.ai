import { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { MapSurface } from "@/components/map/map-surface";
import { useHeadingUp } from "@/components/map/use-compass-heading";
import { I18nProvider, useT } from "@/i18n/provider";
import { PositionProvider, usePosition } from "@/providers/position-provider";
import { autoConnect, getRuntime } from "@/services/runtime";

import CarPlay from "../../../modules/car-play/src/CarPlayModule";
import { carGuidance } from "./car-guidance";

/**
 * The car's screen (docs/CARPLAY-SPEC.md): the React root `CarPlayMap` (index.ts), which modules/car-play mounts
 * while a car is connected, on the same JS runtime and services as the phone's screen. The map follows the car
 * heading-up under the map template's buttons and guidance panel.
 */
export function CarPlayRoot() {
  return (
    <I18nProvider>
      <PositionProvider gnss={false}>
        <CarScreen />
      </PositionProvider>
    </I18nProvider>
  );
}

const noop = () => {};

function CarScreen() {
  useCarSession();
  useCarGuidance();
  const position = usePosition();
  const headingUp = useHeadingUp(position, null);
  return (
    <MapSurface
      mode="follow-heading"
      ghostView={false}
      compass={null}
      headingUpRad={headingUp}
      onUserInteraction={noop}
      onLongPress={noop}
      pin={null}
    />
  );
}

/** A car screen shows the map: GNSS on and the adapter connecting, as when the phone's app opens. */
function useCarSession() {
  useEffect(() => {
    const { position, recorder } = getRuntime();
    recorder.note("carplay connected");
    void position.getPermission().then((result) => {
      if (result.granted) void position.start();
    });
    void autoConnect().catch((error) => console.warn("auto-connect failed", error));
    return () => {
      recorder.note("carplay disconnected");
      // The phone's screen keeps GNSS on while in front (PositionProvider), a trip while in the background.
      if (AppState.currentState !== "active") position.stop();
    };
  }, []);
}

const NOTHING_SENT = { trip: null as string | null, maneuvers: null as string | null, arrived: false };

/** The route's guidance on the map template's panel: a trip per destination, maneuvers when they change. */
function useCarGuidance() {
  const { t, language } = useT();
  const { routes } = getRuntime();
  const route = useSyncExternalStore(routes.subscribe, routes.getSnapshot, routes.getSnapshot);
  const guidance = carGuidance(route, t, language);
  const sent = useRef(NOTHING_SENT);

  useEffect(() => {
    if (!CarPlay) return;
    const was = sent.current;
    if (!guidance) {
      if (was.trip) void CarPlay.endTrip(false);
      sent.current = NOTHING_SENT;
      return;
    }
    const newTrip = guidance.tripKey !== was.trip || (was.arrived && !guidance.arrived);
    if (newTrip) void CarPlay.startTrip(guidance.trip);
    if (newTrip || guidance.maneuversKey !== was.maneuvers) void CarPlay.setManeuvers(guidance.maneuvers);
    if (guidance.arrived && !was.arrived) void CarPlay.endTrip(true);
    else if (!guidance.arrived) void CarPlay.updateEstimates(guidance.estimates);
    sent.current = { trip: guidance.tripKey, maneuvers: guidance.maneuversKey, arrived: guidance.arrived };
  }, [guidance]);
}
