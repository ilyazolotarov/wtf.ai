import type { Strings } from "@/i18n/en";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";
import type { Place, PlacesSnapshot } from "@/services/navigation/places-store";

import type {
  CarAction,
  CarLabelsPayload,
  CarPlacePayload,
  CarRoutePayload,
} from "../../../modules/android-auto/src/AndroidAutoModule";
import { carRoute } from "./car-guidance";

// One connection of the car's screen, on the JS side (docs/ANDROID-AUTO-SPEC.md §3): the headless task CarSessionTask
// runs this while Android Auto shows the app, whatever is on the car's screen. It keeps the navigator running, sends the
// car what to show and acts on what the driver does there, and speaks the route when no other screen does.

export interface CarSessionDeps {
  native: {
    isConnected(): boolean;
    setLabels(labels: CarLabelsPayload): Promise<void>;
    setRoute(route: CarRoutePayload | null): Promise<void>;
    setPlaces(places: CarPlacePayload[]): Promise<void>;
    setVoiceMuted(muted: boolean | null): Promise<void>;
    addListener(event: "onCarAction", listener: (e: CarAction) => void): { remove(): void };
  };
  routes: {
    getSnapshot(): RouteSnapshot | null;
    subscribe(listener: () => void): () => void;
    start(destination: RouteDestination): void;
    stop(): void;
  };
  places: {
    getSnapshot(): PlacesSnapshot;
    subscribe(listener: () => void): () => void;
    addRecent(place: Place): void;
  };
  /** The app's language now. */
  strings(): { language: "en" | "uk"; t(key: keyof Strings): string };
  voice: {
    muted(): boolean;
    setMuted(muted: boolean): void;
    /** 0: no voice at all (Settings). */
    volume(): number;
    subscribe(listener: () => void): () => void;
    /** The car's voice, speaking only while it holds the voice (VoiceGuide). */
    claim(): () => void;
    update(route: RouteSnapshot | null, speedMps: number, muted: boolean, t: (key: keyof Strings) => string, language: "en" | "uk"): void;
  };
  speedMps(): number;
  /** The navigator runs while the car's screen is on (Runtime.setCarScreen). */
  setCarScreen(on: boolean): void;
  /** The remembered adapter, as when the phone's app opens. */
  connect(): void;
  note(text: string): void;
}

/** The car's list: saved places first (Home, Work, favourites), then recent destinations. */
export function carPlaces({ saved, recent }: PlacesSnapshot): CarPlacePayload[] {
  return [
    ...saved.map((p) => ({ id: p.id, title: p.title, detail: p.detail, kind: p.kind })),
    ...recent.map((p) => ({ id: p.id, title: p.title, detail: p.detail, kind: "recent" as const })),
  ];
}

export function carLabels(t: (key: keyof Strings) => string): CarLabelsPayload {
  return {
    endRoute: t("stopGuidance"),
    destinations: t("carDestinations"),
    saved: t("savedPlaces"),
    recent: t("recentPlaces"),
    noDestinations: t("carNoDestinations"),
    voiceOn: t("voiceOn"),
    voiceOff: t("voiceOff"),
    notification: t("carNotification"),
  };
}

/** Runs until the car's screen is gone; resolves then. */
export function runCarSession(deps: CarSessionDeps): Promise<void> {
  const { native, routes, places, voice } = deps;
  return new Promise<void>((resolve) => {
    const cleanups: (() => void)[] = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      cleanups.forEach((c) => c());
      deps.setCarScreen(false);
      deps.note("android auto disconnected");
      resolve();
    };
    const send = (call: Promise<void>) => void call.catch((e: unknown) => deps.note(`android auto: ${e instanceof Error ? e.message : String(e)}`));

    deps.note("android auto connected");
    deps.setCarScreen(true);
    deps.connect();

    // Again when the driver changes the app's language on the phone.
    let labelsIn: string | null = null;
    const sendLabels = (t: (key: keyof Strings) => string, language: string) => {
      if (language === labelsIn) return;
      labelsIn = language;
      send(native.setLabels(carLabels(t)));
    };
    const sendPlaces = () => send(native.setPlaces(carPlaces(places.getSnapshot())));
    const sendVoice = () => send(native.setVoiceMuted(voice.volume() === 0 ? null : voice.muted()));
    const onRoute = () => {
      const { t, language } = deps.strings();
      sendLabels(t, language);
      const route = routes.getSnapshot();
      send(native.setRoute(carRoute(route, t)));
      voice.update(route, deps.speedMps(), voice.muted() || voice.volume() === 0, t, language);
    };

    const listener = native.addListener("onCarAction", (e) => {
      switch (e.action) {
        case "end-route":
          deps.note("android auto: route ended on the car's screen");
          routes.stop();
          return;
        case "go": {
          const { saved, recent } = places.getSnapshot();
          const place = [...saved, ...recent].find((p) => p.id === e.id);
          if (!place) return;
          deps.note("android auto: destination picked on the car's screen");
          places.addRecent(place);
          routes.start({ lat: place.lat, lon: place.lon, name: place.title, id: place.id });
          return;
        }
        case "toggle-voice":
          voice.setMuted(!voice.muted());
          return;
        case "session-ended":
          end();
      }
    });
    cleanups.push(
      () => listener.remove(),
      voice.claim(),
      routes.subscribe(onRoute),
      places.subscribe(sendPlaces),
      voice.subscribe(sendVoice),
    );
    sendPlaces();
    sendVoice();
    onRoute();
    // Gone before the listener was there.
    if (!native.isConnected()) end();
  });
}
