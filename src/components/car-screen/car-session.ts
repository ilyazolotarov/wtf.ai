import type { Strings } from "@/i18n/en";
import type { Coordinate } from "@/nav/geo";
import { addressQueries, geoSearchText, parseGeoUri } from "@/nav/search/geo-uri";
import type { RouteDestination, RouteSnapshot } from "@/services/navigation/route-service";
import type { Place, PlacesSnapshot } from "@/services/navigation/places-store";

import type {
  CarAction,
  CarLabelsPayload,
  CarNote,
  CarNoticePayload,
  CarPlacePayload,
  CarRequest,
  CarRoutePayload,
  CarSearchPayload,
} from "../../../modules/android-auto/src/AndroidAutoModule";
import { carRoute } from "./car-guidance";

// One connection of the car's screen, on the JS side (docs/ANDROID-AUTO-SPEC.md §3): the headless task CarSessionTask
// runs this while Android Auto shows the app, whatever is on the car's screen. It keeps the navigator running, sends the
// car what to show and acts on what the driver does there, and speaks the route when no other screen does.

/** While a notice shows, what it waits for (the permission, the position for a held route) is checked this often. */
export const NOTICE_CHECK_MS = 5000;

type T = (key: keyof Strings) => string;

export interface CarSessionDeps {
  native: {
    isConnected(): boolean;
    setLabels(labels: CarLabelsPayload): Promise<void>;
    setRoute(route: CarRoutePayload | null): Promise<void>;
    setPlaces(places: CarPlacePayload[]): Promise<void>;
    setVoiceMuted(muted: boolean | null): Promise<void>;
    setNotice(notice: CarNoticePayload | null): Promise<void>;
    setSearch(search: CarSearchPayload | null): Promise<void>;
    openSearch(query: string): Promise<void>;
    /** The map, with a list or the search open over it gone. */
    showMap(): Promise<void>;
    takeRequest(): Promise<CarRequest | null>;
    takeNotes(): Promise<CarNote[]>;
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
  /** A route asked for without an adapter, waiting for the driver's word (route-without-adapter.ts). */
  held: {
    get(): RouteDestination | null;
    hold(destination: RouteDestination): void;
    take(): RouteDestination | null;
    subscribe(listener: () => void): () => void;
  };
  /** Phone-only mode with no adapter connected: a new route waits for the driver's word (UI-SPEC §6.3). */
  withoutAdapter(): boolean;
  /** The driver set the position, or GPS is trusted: a route without an adapter can start from it. */
  positionSet(): boolean;
  /** The app's language now. */
  strings(): { language: "en" | "uk"; t: T };
  /** The driver changed the app's language. */
  subscribeLanguage(listener: () => void): () => void;
  /** The phone's app came to the front (the driver may have allowed location there, or changed the language). */
  subscribePhoneInFront(listener: () => void): () => void;
  voice: {
    muted(): boolean;
    setMuted(muted: boolean): void;
    /** 0: no voice at all (Settings). */
    volume(): number;
    subscribe(listener: () => void): () => void;
    /** The car's voice, speaking only while it holds the voice (VoiceGuide). */
    claim(): () => void;
    update(route: RouteSnapshot | null, speedMps: number, muted: boolean, t: T, language: "en" | "uk"): void;
    /** Stops what is being said. */
    hush(): void;
  };
  speedMps(): number;
  /** What a search finds at once (place-search.ts `findPlaces`): a point, the region's index, or its cities. */
  find(text: string): Place[];
  /** How far a place is from the car ("1.2 km"); null without a position. */
  away(at: Coordinate): string | null;
  /** Location permission granted (fine or approximate). */
  located(): Promise<boolean>;
  /** Location allowed since: GNSS started again for the navigator. */
  retryLocation(): void;
  /** The navigator runs while the car's screen is on (Runtime.setCarScreen). */
  setCarScreen(on: boolean): void;
  /** The remembered adapter, as when the phone's app opens. */
  connect(): void;
  note(text: string): void;
  /** What went wrong on the native side, beyond the trip log (Sentry). */
  report(text: string): void;
  /** `fn` every `ms`, until the returned stop. */
  every(ms: number, fn: () => void): () => void;
}

/** The car's list: saved places first (Home, Work, favourites), then recent destinations. */
export function carPlaces({ saved, recent }: PlacesSnapshot): CarPlacePayload[] {
  return [
    ...saved.map((p) => ({ id: p.id, title: p.title, detail: p.detail, kind: p.kind })),
    ...recent.map((p) => ({ id: p.id, title: p.title, detail: p.detail, kind: "recent" as const })),
  ];
}

export function carLabels(t: T): CarLabelsPayload {
  return {
    endRoute: t("stopGuidance"),
    destinations: t("carDestinations"),
    saved: t("savedPlaces"),
    recent: t("recentPlaces"),
    noDestinations: t("carNoDestinations"),
    search: t("carSearch"),
    searchHint: t("searchPlaces"),
    noResults: t("noSearchResults"),
    checkPhone: t("carCheckPhone"),
    notification: t("carNotification"),
  };
}

/**
 * What the driver must do before the car can guide: allow location (unknown until checked: nothing yet), then agree
 * to a route held without an adapter, once the position is set (the card says to set it first, else to follow the
 * route exactly). The car's card has two short lines: one instruction at a time.
 */
export function carNotice(located: boolean | null, held: RouteDestination | null, positionSet: boolean, t: T): CarNoticePayload | null {
  if (located === false) return { kind: "location", title: t("locationOff"), text: t("carLocationNeeded"), action: t("carAllowLocation") };
  if (held) {
    const text = t(positionSet ? "carHeldFollow" : "carHeldSetPosition");
    return { kind: "held-route", title: t("carHeldTitle"), text, action: t("noAdapterRouteAgree") };
  }
  return null;
}

/** A house the search found (its id `search:a<address>`, place-search.ts `resultPlace`; SEARCH-SPEC §4). */
const isHouse = (p: Place) => p.id.startsWith("search:a");

const sameNotice = (a: CarNoticePayload | null, b: CarNoticePayload | null) =>
  a === b || (a != null && b != null && a.kind === b.kind && a.title === b.title && a.text === b.text && a.action === b.action);

/** Runs until the car's screen is gone; resolves then. */
export function runCarSession(deps: CarSessionDeps): Promise<void> {
  const { native, routes, places, voice, held } = deps;
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

    // What the native side noted (the map's surface, the location service, what failed), into the trip log.
    const takeNotes = () =>
      void native
        .takeNotes()
        .then((notes) => {
          for (const n of notes) {
            deps.note(`android auto: ${n.text}`);
            if (n.problem) deps.report(`android auto: ${n.text}`);
          }
        })
        .catch((e: unknown) => deps.note(`android auto: notes not taken: ${e instanceof Error ? e.message : String(e)}`));

    // Again when the driver changes the app's language.
    let labelsIn: string | null = null;
    const sendLabels = (t: T, language: string) => {
      if (language === labelsIn) return;
      labelsIn = language;
      send(native.setLabels(carLabels(t)));
    };
    const sendPlaces = () => send(native.setPlaces(carPlaces(places.getSnapshot())));
    const sendVoice = () => send(native.setVoiceMuted(voice.volume() === 0 ? null : voice.muted()));
    let hadRoute = false;
    const onRoute = () => {
      const { t, language } = deps.strings();
      sendLabels(t, language);
      const route = routes.getSnapshot();
      send(native.setRoute(carRoute(route, t, language)));
      voice.update(route, deps.speedMps(), voice.muted() || voice.volume() === 0, t, language);
      // Ending the route ends what it was saying (the phone's map does the same while it is mounted).
      if (hadRoute && !route) voice.hush();
      hadRoute = route != null;
    };

    // The notice, and while one shows, a check now and then for what it waits for.
    let located: boolean | null = null;
    // Undefined until sent: the native side keeps the last one, also from a JS runtime before a reload.
    let notice: CarNoticePayload | null | undefined;
    let stopChecks: (() => void) | null = null;
    const sendNotice = () => {
      const next = carNotice(located, held.get(), deps.positionSet(), deps.strings().t);
      if (notice === undefined || !sameNotice(next, notice)) {
        notice = next;
        send(native.setNotice(next));
      }
      if (next && !stopChecks) stopChecks = deps.every(NOTICE_CHECK_MS, check);
      else if (!next && stopChecks) {
        stopChecks();
        stopChecks = null;
      }
    };
    const checkLocation = () =>
      void deps
        .located()
        .then((granted) => {
          if (ended) return;
          const was = located;
          located = granted;
          if (!granted && was !== false) deps.note("android auto: no location permission");
          if (granted && was === false) {
            deps.note("android auto: location allowed");
            deps.retryLocation();
          }
          sendNotice();
        })
        .catch((e: unknown) => deps.note(`android auto: location permission unknown: ${e instanceof Error ? e.message : String(e)}`));
    const check = () => (located === false ? checkLocation() : sendNotice());
    const refreshWords = () => {
      onRoute();
      sendNotice();
    };

    // A place to go to, as the phone's route screen goes: a recent destination from now; without an adapter, the route
    // waits for the driver's word.
    const goTo = (place: Place, how: string) => {
      places.addRecent(place);
      const destination = { lat: place.lat, lon: place.lon, name: place.title, id: place.id };
      if (deps.withoutAdapter()) {
        deps.note(`android auto: ${how}, held: no adapter`);
        routes.stop();
        held.hold(destination);
        return;
      }
      deps.note(`android auto: ${how}`);
      routes.start(destination);
    };

    // The search screen's answers, as the driver types (the phone's offline search; nearest first).
    let found: Place[] = [];
    const show = (text: string, answers: Place[]) => {
      found = answers;
      const results = answers.map((p) => {
        const detail = [p.detail, deps.away(p)].filter(Boolean).join(" · ");
        return { id: p.id, title: p.title, detail: detail || null, kind: "result" as const };
      });
      send(native.setSearch({ query: text, results }));
    };
    const search = (text: string) => show(text, text.trim() ? deps.find(text) : []);

    // A place the car's assistant or another app asked for (SEARCH-SPEC §4.6): to go to, a point is gone to and words
    // with one answer too; else the answers show to pick from, as when asked only to look for it. The assistant's
    // address is searched as the index holds it, less of it while nothing is found (`addressQueries`).
    const request = ({ navigate, uri }: CarRequest) => {
      const geo = parseGeoUri(uri);
      if (!geo) {
        deps.note("android auto: a place asked for, not understood");
        return;
      }
      const wordings = geo.point ? [geoSearchText(uri)!] : addressQueries(geo.query!);
      let text = wordings[0];
      let answers = deps.find(text);
      for (const wording of wordings.slice(1)) {
        if (answers.length > 0) break;
        const more = deps.find(wording);
        if (more.length > 0) [text, answers] = [wording, more];
      }
      show(text, answers);
      // One answer, or one house among them (its street comes too): no doubt where to go.
      const houses = answers.filter(isHouse);
      const sure = geo.point != null || answers.length === 1 || (houses.length === 1 && answers[0] === houses[0]);
      if (navigate && sure && answers.length > 0) {
        const place = answers[0];
        goTo(geo.point && geo.query ? { ...place, title: geo.query } : place, "place asked for on the car");
        // A list or the search the driver had open would hide the route, or the card asking for their word.
        send(native.showMap());
        return;
      }
      deps.note(`android auto: place asked for on the car: ${answers.length} found`);
      send(native.openSearch(text));
    };
    const takeRequest = () =>
      void native
        .takeRequest()
        .then((r) => {
          if (r && !ended) request(r);
        })
        .catch((e: unknown) => deps.note(`android auto: request not taken: ${e instanceof Error ? e.message : String(e)}`));

    const listener = native.addListener("onCarAction", (e) => {
      switch (e.action) {
        case "end-route":
          deps.note("android auto: route ended on the car's screen");
          routes.stop();
          return;
        case "go": {
          const { saved, recent } = places.getSnapshot();
          const listed = [...saved, ...recent].find((p) => p.id === e.id);
          const result = listed ? undefined : found.find((p) => p.id === e.id);
          if (listed) goTo(listed, "destination picked on the car's screen");
          else if (result) goTo(result, "search result picked on the car's screen");
          return;
        }
        case "search":
          search(e.text);
          return;
        case "request":
          takeRequest();
          return;
        case "confirm-held": {
          const destination = held.take();
          if (!destination) return;
          deps.note("route without an adapter: the driver will follow it (car's screen)");
          routes.start(destination);
          return;
        }
        case "cancel-held":
          if (held.take()) deps.note("android auto: route without an adapter dropped on the car's screen");
          return;
        case "toggle-voice":
          voice.setMuted(!voice.muted());
          return;
        case "permission":
          checkLocation();
          return;
        case "notes":
          takeNotes();
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
      held.subscribe(sendNotice),
      deps.subscribeLanguage(refreshWords),
      deps.subscribePhoneInFront(() => {
        refreshWords();
        if (located === false) checkLocation();
      }),
      () => stopChecks?.(),
    );
    takeNotes();
    sendPlaces();
    sendVoice();
    onRoute();
    sendNotice();
    checkLocation();
    takeRequest();
    // Gone before the listener was there.
    if (!native.isConnected()) end();
  });
}
