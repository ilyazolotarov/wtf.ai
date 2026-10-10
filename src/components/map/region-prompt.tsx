import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { GlassFill } from "@/components/ui/glass-fill";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import type { Coordinate } from "@/nav/geo";
import { usePosition } from "@/providers/position-provider";
import {
  downloadRegion,
  loadCatalog,
  setActiveRegion,
  useMapPacks,
  type InstalledState,
} from "@/services/offline-map/map-packs";
import type { MapCatalog } from "@/services/offline-map/catalog";
import {
  adviseRegion,
  regionCheckPoint,
  type RegionAdvice,
  type RegionShape,
} from "@/services/offline-map/region-check";

interface Region extends RegionShape {
  name: { en: string; uk: string };
  size?: number;
}

/** "active→target" pairs the driver said "Not now" to, until the app restarts. */
const dismissed = new Set<string>();
/**
 * `activate`: a region downloaded from this prompt becomes the map once it is installed.
 * `catalogRequested`: the catalog is fetched (from GitHub) once per run, only when the car is outside the region.
 */
const pending: { activate: string | null; catalogRequested: boolean } = { activate: null, catalogRequested: false };

function downloadAndActivate(region: string) {
  pending.activate = region;
  void downloadRegion(region);
}

/** Where the car is, rounded to ~100 m (and its accuracy to 100 m): the advice changes only as it moves on. */
function useCheckPoint(): { at: Coordinate; marginM: number } | null {
  const position = usePosition();
  const check = position ? regionCheckPoint(position) : null;
  const lat = check ? Math.round(check.at.lat * 1000) / 1000 : null;
  const lon = check ? Math.round(check.at.lon * 1000) / 1000 : null;
  const marginM = check ? Math.ceil(check.marginM / 100) * 100 : null;
  return useMemo(
    () => (lat === null || lon === null || marginM === null ? null : { at: { lat, lon }, marginM }),
    [lat, lon, marginM],
  );
}

function advise(
  installed: InstalledState,
  catalog: MapCatalog | null,
  check: { at: Coordinate; marginM: number } | null,
): RegionAdvice<Region> | null {
  const active = installed.active ? installed.regions[installed.active] : null;
  if (!check || !active) return null;
  // Installs made before outlines borrow the catalog's.
  const shape = (r: Region): Region =>
    r.outline ? r : { ...r, outline: catalog?.regions.find((c) => c.region === r.region)?.outline };
  const mine = Object.values(installed.regions).map(shape);
  const catalogRegions: Region[] = (catalog?.regions ?? []).map((r) => ({
    ...r,
    size: r.size + (r.graph?.size ?? 0) + (r.search?.size ?? 0),
  }));
  return adviseRegion(shape(active), mine, catalogRegions, check.at, check.marginM);
}

/**
 * Card on the map when the car (any fix but a spoofed one) is more than 1 km outside the active offline
 * region (UI-SPEC §6): switch to a downloaded region that has it, or download the one that
 * does. "Not now" hides it for that pair of regions until the app restarts.
 */
export function RegionPrompt({ panelStyle }: { panelStyle: StyleProp<ViewStyle> }) {
  const { t, language } = useT();
  const { installed, catalog, catalogLoading, download } = useMapPacks();
  const check = useCheckPoint();
  const [, setDismissals] = useState(0);
  const advice = useMemo(() => advise(installed, catalog, check), [installed, catalog, check]);
  const outside = advice !== null && advice.kind !== "inside";

  useEffect(() => {
    if (outside && !catalog && !catalogLoading && !pending.catalogRequested) {
      pending.catalogRequested = true;
      void loadCatalog();
    }
  }, [outside, catalog, catalogLoading]);

  useEffect(() => {
    if (pending.activate && installed.regions[pending.activate]) {
      setActiveRegion(pending.activate);
      pending.activate = null;
    }
  }, [installed]);

  if (!advice || advice.kind === "inside" || !installed.active) return null;
  const active = installed.regions[installed.active];
  const target = advice.kind === "outside" ? null : advice.region;
  const key = `${installed.active}→${target?.region ?? "?"}`;
  if (dismissed.has(key)) return null;
  // That region is downloading (or paused): Offline data shows it. Any other download doesn't hide the card.
  if (download && target && download.region === target.region) return null;

  const body =
    advice.kind === "switch"
      ? t("regionSwitchBody").replace("{region}", advice.region.name[language])
      : advice.kind === "download"
        ? t("regionDownloadBody")
            .replace("{region}", advice.region.name[language])
            .replace("{size}", advice.region.size ? `${Math.round(advice.region.size / 1e6)} MB` : "")
            .replace(" ()", "")
        : t("regionUnknownBody");
  const action =
    advice.kind === "switch"
      ? { label: t("regionSwitch"), onPress: () => setActiveRegion(advice.region.region) }
      : advice.kind === "download"
        ? {
            label: t("download"),
            onPress: () => {
              downloadAndActivate(advice.region.region);
              router.push("/downloads");
            },
          }
        : { label: t("downloads"), onPress: () => router.push("/downloads") };

  return (
    <RegionPromptCard
      panelStyle={panelStyle}
      title={t("regionOutsideTitle").replace("{region}", active.name[language])}
      body={body}
      action={action}
      onDismiss={() => {
        dismissed.add(key);
        setDismissals((n) => n + 1);
      }}
    />
  );
}

/** The card itself (the developer's UI gallery draws it without a region check). */
export function RegionPromptCard({
  panelStyle,
  title,
  body,
  action,
  onDismiss,
}: {
  panelStyle: StyleProp<ViewStyle>;
  title: string;
  body: string;
  action: { label: string; onPress(): void };
  onDismiss(): void;
}) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <View style={[panelStyle, styles.card]}>
      <GlassFill radius={Radius.rL} />
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: palette.warn.a }]}>
          <Icon name="download" size={20} color={palette.warn.c} />
        </View>
        <View style={styles.text}>
          <T w="semibold" size={15}>
            {title}
          </T>
          <T size={13} color={palette.text2}>
            {body}
          </T>
        </View>
      </View>
      <View style={styles.buttons}>
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.accent }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.onAccent} fit>
            {action.label}
          </T>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, { backgroundColor: palette.surface }, pressed && styles.pressed]}
        >
          <T w="semibold" size={14} color={palette.accent} fit>
            {t("notNow")}
          </T>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: Radius.rL },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  // Side by side, equal, while both labels fit; otherwise stacked (a large text size, a long label).
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flexGrow: 1, minWidth: "40%", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
  pressed: { opacity: 0.7 },
});
