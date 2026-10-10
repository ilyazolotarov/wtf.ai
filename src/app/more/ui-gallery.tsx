import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { TourInvite } from "@/components/guide/map-tour";
import { BottomBar } from "@/components/map/bottom-bar";
import { CameraButton } from "@/components/map/camera-button";
import { NoFixCard, PermissionCard } from "@/components/map/center-cards";
import { HeldRouteCard, PinCard } from "@/components/map/destination-cards";
import { HudChip, usePanelStyle } from "@/components/map/hud-card";
import { ManualChip, ManualQuestionCard, PlacingCard, PoseQuestionCard } from "@/components/map/placing-cards";
import { RegionPromptCard } from "@/components/map/region-prompt";
import { StatusRow } from "@/components/map/status-row";
import { OutageCard, SinceTrustedStrip, TrustAlertCard, trustAlertText } from "@/components/map/trust-cards";
import { RouteBanner } from "@/components/route/route-banner";
import { SaveConfirmation } from "@/components/route/save-feedback";
import { ScreenContent, SectionLabel } from "@/components/screens/screen-ui";
import { navStatusFrom, type AdapterStatus } from "@/components/status/use-nav-status";
import { FontScaleLimit, MAP_MAX_FONT_SCALE } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { PositionEstimate, TrustState } from "@/nav/position/types";
import type { GuidanceState, GuidanceStep } from "@/nav/routing/guidance";
import type { Maneuver } from "@/nav/routing/maneuvers";
import type { RouteSnapshot } from "@/services/navigation/route-service";

/**
 * Every panel the map shows only in some state, drawn at once with made-up data (Developer → UI gallery): the way to
 * see them all at a large text size and in both languages (`scripts/android-ui-sweep.sh` screenshots this page).
 * Buttons do nothing.
 */
export default function UiGalleryScreen() {
  const { t, language } = useT();
  const label = (english: string, ukrainian: string) => language === "uk" ? ukrainian : english;
  const palette = usePalette();
  const panel = usePanelStyle();
  // Fixed once, so the ages ("4 min ago") don't tick between screenshots.
  const [now] = useState(() => Date.now());
  const none = () => {};
  const nav = (trust: TrustState | null, adapter: AdapterStatus, extra: Partial<PositionEstimate> = {}) =>
    navStatusFrom(trust ? position(now, trust, extra) : null, adapter, false, palette, t);

  const statuses: [string, ReturnType<typeof nav>][] = [
    [label("trusted", "надійна позиція"), nav("TRUSTED", "on")],
    [label("dead reckoning", "за даними авто"), nav("NO_FIX", "on")],
    [label("Wi-Fi fix, no adapter", "позиція за Wi-Fi, без адаптера"), nav("NO_FIX", "off", { speedMps: undefined })],
    [label("spoofed", "підміна GPS"), nav("UNTRUSTED", "on")],
    [label("reacquiring", "перевірка GPS"), nav("REACQUIRING", "on")],
    [label("placed by hand", "указано вручну"), nav("NO_FIX", "on", { source: "manual" })],
    [label("no position", "позиція невідома"), nav(null, "off")],
  ];
  const routeStates = demoRouteStates(label);
  const spoofed = nav("UNTRUSTED", "off");
  const ghost = { lat: 50.47, lon: 30.6, accuracyM: 8, timestamp: now };
  const manual = { placedAt: now - 300_000, confirmedAt: now - 240_000, asking: false };

  return (
    <ScreenContent title={t("uiGallery")}>
      <Group title={label("Status pill", "Індикатор стану")}>
        {statuses.map(([name, status]) => (
          <Item key={name} name={name}>
            <StatusRow nav={status} expandable expanded={false} onToggle={none} />
          </Item>
        ))}
      </Group>

      <Group title={label("Under the pill", "Під індикатором стану")}>
        <Item name={label("since trusted, driven", "від останньої надійної позиції, у дорозі")}>
          <SinceTrustedStrip position={position(now, "UNTRUSTED", { lastTrustedFixAt: now - 240_000, distanceSinceTrustedM: 2300 })} />
        </Item>
        {(["UNTRUSTED", "NO_FIX", "REACQUIRING"] as const).map((trust) => {
          const status = nav(trust, "off");
          return (
            <Item key={trust} name={`${label("trust alert", "попередження про GPS")} ${trust}`}>
              <TrustAlertCard
                nav={status}
                text={trustAlertText(status, t) ?? ""}
                ghost={trust === "UNTRUSTED" ? ghost : undefined}
                showingGhost={false}
                onToggleGhost={none}
              />
            </Item>
          );
        })}
        <Item name={label("trust alert, Wi-Fi fix", "попередження: позиція за Wi-Fi")}>
          <TrustAlertCard nav={statuses[2][1]} text={trustAlertText(statuses[2][1], t) ?? ""} ghost={undefined} showingGhost={false} onToggleGhost={none} />
        </Item>
        <Item name={label("spoof, showing the claim", "підміна: позиція за GPS")}>
          <TrustAlertCard nav={spoofed} text={trustAlertText(spoofed, t) ?? ""} ghost={ghost} showingGhost onToggleGhost={none} />
        </Item>
        <Item name={label("simulated outage", "імітація втрати GPS")}>
          <OutageCard outage={{ startedAt: now - 95_000, distanceM: 1830, errorM: 24, maxErrorM: 61 }} nowMs={now} onRestore={none} />
          <OutageCard outage={{ startedAt: now - 20_000, distanceM: 120 }} nowMs={now} onRestore={none} />
        </Item>
        <Item name={label("chips", "позначки стану")}>
          <HudChip icon="location_on" label={t("placeOffer")} color={palette.accent} onPress={none} />
          <HudChip icon="bluetooth" label={t("obdFindingProtocol")} color={palette.warn.c} />
          <HudChip icon="gps_off" label={t("cutGps")} color={palette.accent} onPress={none} />
          <ManualChip manual={manual} onPlace={none} onForget={none} />
          <ManualChip manual={manual} onPlace={undefined} onForget={none} />
        </Item>
        <Item name={label("region prompt", "вибір регіону")}>
          <RegionPromptCard
            panelStyle={panel}
            title={t("regionOutsideTitle").replace("{region}", label("Kyiv Oblast", "Київська область"))}
            body={t("regionSwitchBody").replace("{region}", label("Zhytomyr Oblast", "Житомирська область"))}
            action={{ label: t("regionSwitch"), onPress: none }}
            onDismiss={none}
          />
          <RegionPromptCard
            panelStyle={panel}
            title={t("regionOutsideTitle").replace("{region}", label("Kyiv", "Київ"))}
            body={t("regionDownloadBody").replace("{region}", label("Chernihiv Oblast", "Чернігівська область")).replace("{size}", label("61 MB", "61 МБ"))}
            action={{ label: t("download"), onPress: none }}
            onDismiss={none}
          />
          <RegionPromptCard
            panelStyle={panel}
            title={t("regionOutsideTitle").replace("{region}", label("Kyiv", "Київ"))}
            body={t("regionUnknownBody")}
            action={{ label: t("downloads"), onPress: none }}
            onDismiss={none}
          />
        </Item>
      </Group>

      <Group title={label("Putting the car on the map", "Позиція авто на мапі")}>
        <Item name={label("placing: where", "укажіть позицію")}>
          <PlacingCard step="position" hasHeading={false} onCancel={none} onNext={none} />
        </Item>
        <Item name={label("placing: which way, before and after the tap", "укажіть напрямок: до й після натискання")}>
          <PlacingCard step="heading" hasHeading={false} onCancel={none} onNext={none} />
          <PlacingCard step="heading" hasHeading onCancel={none} onNext={none} />
        </Item>
        <Item name={label("is the car where the dot is?", "авто там, де точка?")}>
          <PoseQuestionCard distanceM={420} onAnswer={none} />
        </Item>
        <Item name={label("still where you put it?", "авто досі там, де ви вказали?")}>
          <ManualQuestionCard manual={{ ...manual, asking: true }} onAnswer={none} />
        </Item>
      </Group>

      <Group title={label("Route", "Маршрут")}>
        {routeStates.map(([name, route, muted, offPhone]) => (
          <Item key={name} name={name}>
            <RouteBanner route={route} nowMs={now} onStop={none} muted={muted} onToggleVoice={none} offPhone={offPhone} />
          </Item>
        ))}
        <Item name={label("voice off in Settings", "голос вимкнено в налаштуваннях")}>
          <RouteBanner route={routeStates[2][1]} nowMs={now} onStop={none} muted={false} />
        </Item>
        <Item name={label("dropped pin, standing / moving", "обрана точка, авто стоїть / рухається")}>
          <PinCard pin={{ lat: 50.46, lon: 30.53 }} position={position(now, "TRUSTED")} onClose={none} onPlace={none} onRoute={none} />
          <PinCard pin={{ lat: 50.46, lon: 30.53 }} position={null} onClose={none} onPlace={undefined} onRoute={none} />
        </Item>
        <Item name={label("route held without an adapter", "маршрут без адаптера")}>
          <HeldRouteCard manual={undefined} trusted={false} mayPlace onPlace={none} onCancel={none} onConfirm={none} />
          <HeldRouteCard manual={undefined} trusted={false} mayPlace={false} onPlace={none} onCancel={none} onConfirm={none} />
          <HeldRouteCard manual={manual} trusted={false} mayPlace onPlace={none} onCancel={none} onConfirm={none} />
          <HeldRouteCard manual={undefined} trusted mayPlace onPlace={none} onCancel={none} onConfirm={none} />
        </Item>
        <Item name={label("saved place", "збережене місце")}>
          <SaveConfirmation kind="home" replaced={label("Khreshchatyk 22", "Хрещатик, 22")} onUndo={none} />
          <SaveConfirmation kind="favorite" replaced={null} onUndo={none} />
          <SaveConfirmation kind={null} replaced={null} onUndo={none} />
        </Item>
      </Group>

      <Group title={label("Map, bottom and centre", "Мапа: нижня й центральна частини")}>
        <Item name={label("tour invite", "запрошення до огляду")}>
          <TourInvite panelStyle={panel} onStart={none} onDismiss={none} />
        </Item>
        <Item name={label("camera button: follow, heading-up, free", "режим мапи: за авто, за курсом, вільний")}>
          <View style={styles.row}>
            <CameraButton mode="follow" onPress={none} />
            <CameraButton mode="follow-heading" onPress={none} />
            <CameraButton mode="free" onPress={none} />
          </View>
        </Item>
        <Item name={label("bottom bar, parked / driving", "нижня панель, стоянка / поїздка")}>
          <BottomBar recording={false} onLayout={none} />
          <BottomBar recording onLayout={none} />
        </Item>
        <Item name={label("location denied / no fix yet", "немає доступу до геопозиції / позицію ще не визначено")}>
          <PermissionCard />
          <NoFixCard />
        </Item>
      </Group>
    </ScreenContent>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <SectionLabel>{title}</SectionLabel>
      {children}
    </View>
  );
}

/** One state, over a stand-in for the map so the frosted panels read as they do there. */
function Item({ name, children }: { name: string; children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={styles.item}>
      <SectionLabel>{name}</SectionLabel>
      {/* The map screen's panels grow as much as there. */}
      <FontScaleLimit max={MAP_MAX_FONT_SCALE}>
        <View style={[styles.stage, { backgroundColor: palette.line }]}>{children}</View>
      </FontScaleLimit>
    </View>
  );
}

function position(now: number, trust: TrustState, extra: Partial<PositionEstimate> = {}): PositionEstimate {
  return {
    lat: 50.45,
    lon: 30.52,
    accuracyM: trust === "TRUSTED" ? 5 : 140,
    speedMps: 13,
    source: trust === "TRUSTED" ? "gnss" : "fused",
    trust,
    timestamp: now,
    ...extra,
  };
}

/** The banner's states: name, route, muted, voice off the phone. */
function demoRouteStates(label: (english: string, ukrainian: string) => string): [string, RouteSnapshot, boolean, boolean][] {
  const destination = { lat: 50.4, lon: 30.6, name: label("Boryspil", "Бориспіль") };
  const maneuvers: Maneuver[] = [
    { kind: "depart", atM: 0, lat: 50.45, lon: 30.52, turnRad: 0 },
    { kind: "roundabout", atM: 900, lat: 50.45, lon: 30.53, turnRad: 1.2, exit: 3 },
    { kind: "keep-right", atM: 960, lat: 50.45, lon: 30.54, turnRad: 0.3 },
    { kind: "arrive", atM: 31_000, lat: 50.4, lon: 30.6, turnRad: 0 },
  ];
  const plan = { legs: [], lengthM: 31_000, durationS: 2460, coordinates: [], offRoadM: { start: 0, end: 0 } };
  // Only what the banner reads; the progress point is the map's.
  const guidance = (state: GuidanceState, extra: Partial<GuidanceStep> = {}) =>
    ({ state, alongM: 300, offM: 4, remainingM: 30_700, remainingS: 2400, nextIndex: 1, toNextM: 600, thenIndex: null, ...extra }) as GuidanceStep;
  const active = (g: RouteSnapshot["guidance"], extra: Partial<RouteSnapshot> = {}): RouteSnapshot => ({
    destination,
    status: "active",
    planId: 1,
    plan,
    maneuvers,
    guidance: g,
    replanning: false,
    ...extra,
  });
  return [
    [label("planning", "прокладаємо маршрут"), { destination, status: "planning", planId: 1, replanning: false }, false, false],
    [label("failed", "маршрут не знайдено"), { destination, status: "failed", failure: "no-road-at-destination", planId: 1, replanning: false }, false, false],
    [label("on route", "на маршруті"), active(guidance("on")), false, false],
    [label("on route, then keep right, muted", "на маршруті, потім тримайтеся правіше, без звуку"), active(guidance("on", { toNextM: 80, thenIndex: 2 })), true, false],
    [label("voice to the car's Bluetooth", "голос через Bluetooth авто"), active(guidance("on")), false, true],
    [label("planning again", "перепрокладаємо маршрут"), active(guidance("off"), { replanning: true }), false, false],
    [label("re-plan failed", "не вдалося перепрокласти маршрут"), active(guidance("off"), { replanFailure: "no-route" }), false, false],
    [label("position uncertain", "позиція неточна"), active(guidance("unsure")), false, false],
    [label("arrived", "прибуття"), active(guidance("arrived")), false, false],
  ];
}

const styles = StyleSheet.create({
  group: { gap: 10 },
  item: { gap: 6 },
  stage: { gap: 10, padding: 10, borderRadius: 20 },
  row: { flexDirection: "row", gap: 12 },
});
