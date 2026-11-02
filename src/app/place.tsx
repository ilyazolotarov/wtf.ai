import { router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";

import { PlaceCard, type PlaceCardExit } from "@/components/route/place-card";
import { ScreenContent } from "@/components/screens/screen-ui";
import { useT } from "@/i18n/provider";
import type { Place } from "@/services/navigation/places-store";

/**
 * A place picked on the route page (a search result, a saved or recent place, a city): its card, a page over the list
 * so the back swipe returns to it (STOPS-SPEC §7.1). `place`: the place as JSON.
 */
export default function PlaceScreen() {
  const { t } = useT();
  const { place: json } = useLocalSearchParams<{ place?: string }>();
  const place = useMemo((): Place | null => {
    try {
      return json ? (JSON.parse(json) as Place) : null;
    } catch {
      return null;
    }
  }, [json]);
  const exit = (how: PlaceCardExit) => {
    if (how === "map") router.dismissAll();
    // A route started to it: the stop search in this page's place, the route page under it.
    else if (how === "adding") router.replace({ pathname: "/route", params: { adding: "1" } });
    else router.back();
  };
  return <ScreenContent title={t("route")}>{place && <PlaceCard place={place} onExit={exit} />}</ScreenContent>;
}
