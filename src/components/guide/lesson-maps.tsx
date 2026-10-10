import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { formatMb, IconButton } from "@/components/downloads/region-downloads";
import { ExplainCard, LessonIntro } from "@/components/guide/lesson-ui";
import { ScreenAction, ScreenCard, ScreenSection, SectionLabel } from "@/components/screens/screen-ui";
import { Icon } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { Radius, usePalette } from "@/constants/theme";
import type { Strings } from "@/i18n/en";
import { useT } from "@/i18n/provider";
import { useMapPacks } from "@/services/offline-map/map-packs";

interface Row {
  id: string;
  name: string;
  /** Bytes; unknown for the example regions. */
  size: number | null;
  osmDate: string | null;
}

/** Shown when the phone has no catalog nor maps to take names from. */
const EXAMPLES: { id: string; name: keyof Strings }[] = [
  { id: "ukraine", name: "mapsUkraine" },
  { id: "kyiv", name: "mapsKyiv" },
  { id: "lviv", name: "mapsLviv" },
  { id: "odesa", name: "mapsOdesa" },
];
const MAX_ROWS = 5;
const STEP_MS = 250;
/** A pretend download takes about this many steps. */
const STEPS = 14;

/**
 * Lesson 9: the Offline maps screen (UI-SPEC §7.4), drawn as the app draws it, with the phone's own regions when it
 * has them; downloads, switching and deleting are pretend and never touch the real maps.
 */
export function LessonMaps() {
  const { t, language } = useT();
  const palette = usePalette();
  const { installed, catalog } = useMapPacks();

  // The regions: installed ones first, then the catalog's, Ukraine first, as the screen sorts them.
  const real = new Map<string, Row>();
  for (const r of Object.values(installed.regions)) {
    real.set(r.region, { id: r.region, name: r.name[language], size: r.size + (r.graph?.size ?? 0) + (r.search?.size ?? 0), osmDate: r.osm_date });
  }
  for (const r of catalog?.regions ?? []) {
    if (!real.has(r.region)) {
      real.set(r.region, { id: r.region, name: r.name[language], size: r.size + (r.graph?.size ?? 0) + (r.search?.size ?? 0), osmDate: catalog!.osm_date });
    }
  }
  const rows: Row[] =
    real.size >= 2
      ? [...real.values()].slice(0, MAX_ROWS).sort((a, b) => (a.id === "ukraine" ? -1 : b.id === "ukraine" ? 1 : a.name.localeCompare(b.name, language)))
      : EXAMPLES.map((e) => ({ id: e.id, name: t(e.name), size: null, osmDate: null }));

  // Only the map in use starts downloaded (the phone's own, else the first example after Ukraine): the rest are there
  // to try a download on, whatever the phone really has.
  const [active, setActive] = useState<string | null>(() =>
    installed.active && rows.some((r) => r.id === installed.active) ? installed.active : (rows[1] ?? rows[0]).id,
  );
  const [have, setHave] = useState<ReadonlySet<string>>(() => new Set(active ? [active] : []));
  const [download, setDownload] = useState<{ id: string; step: number; paused: boolean } | null>(null);

  // A pretend download, a step at a time; paused, it waits.
  useEffect(() => {
    if (!download || download.paused) return;
    const timer = setTimeout(() => {
      if (download.step + 1 < STEPS) setDownload({ ...download, step: download.step + 1 });
      else {
        setHave((was) => new Set([...was, download.id]));
        setDownload(null);
      }
    }, STEP_MS);
    return () => clearTimeout(timer);
  }, [download]);

  const activeRow = rows.find((r) => r.id === active) ?? null;
  const remove = (id: string) => {
    const left = new Set([...have].filter((x) => x !== id));
    setHave(left);
    if (active === id) setActive([...left][0] ?? null);
  };
  const progress = (row: Row) => {
    if (!download) return null;
    const share = download.step / STEPS;
    const amount = row.size ? `${formatMb(row.size * share)} / ${formatMb(row.size)}` : `${Math.round(share * 100)} %`;
    return (
      <View style={styles.progress}>
        <T size={13} color={palette.text2}>
          {download.paused ? `${t("paused")} · ${amount}` : `${t("downloading")} ${amount}`}
        </T>
        <View style={[styles.bar, { backgroundColor: palette.surface }]}>
          <View style={[styles.barFill, { backgroundColor: palette.accent, width: `${share * 100}%` }]} />
        </View>
        <View style={styles.actions}>
          {download.paused ? (
            <ScreenAction labelKey="resume" compact onPress={() => setDownload({ ...download, paused: false })} />
          ) : (
            <ScreenAction labelKey="pause" compact secondary onPress={() => setDownload({ ...download, paused: true })} />
          )}
          <ScreenAction labelKey="cancel" compact secondary onPress={() => setDownload(null)} />
        </View>
      </View>
    );
  };

  return (
    <>
      <LessonIntro>{t("mapsIntro")}</LessonIntro>

      <ScreenCard style={styles.card}>
        <View style={styles.head}>
          <View style={styles.copy}>
            <T w="semibold" size={16}>
              {activeRow ? activeRow.name : t("mapTiles")}
            </T>
            <T size={12} color={palette.text2}>
              {activeRow
                ? [activeRow.size && formatMb(activeRow.size), activeRow.osmDate && `OSM ${activeRow.osmDate}`].filter(Boolean).join(" · ") || t("readyOffline")
                : t("noMapYet")}
            </T>
          </View>
          <T w="semibold" size={13} color={activeRow ? palette.ok.c : palette.text2}>
            {activeRow ? t("readyOffline") : t("notDownloaded")}
          </T>
        </View>
      </ScreenCard>

      <ScreenSection title={t("mapRegions")}>
        {rows.map((row) => {
          const owned = have.has(row.id);
          const isActive = active === row.id;
          const busy = download?.id === row.id;
          return (
            <View key={row.id} style={styles.row}>
              <View style={styles.rowHead}>
                <Pressable
                  style={styles.copy}
                  disabled={!owned || isActive}
                  onPress={() => setActive(row.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("useMap")}: ${row.name}`}
                >
                  <T w={isActive ? "semibold" : "regular"} size={15}>
                    {row.name}
                  </T>
                  <T size={12} color={isActive ? palette.ok.c : palette.text2}>
                    {[row.size && formatMb(row.size), owned && (isActive ? t("activeMap") : t("downloaded"))].filter(Boolean).join(" · ") ||
                      t("notDownloaded")}
                  </T>
                </Pressable>
                {!download && !owned && (
                  <IconButton icon="download" label={t("download")} onPress={() => setDownload({ id: row.id, step: 0, paused: false })} />
                )}
                {owned && !busy && <IconButton icon="delete" danger label={t("delete")} onPress={() => remove(row.id)} />}
              </View>
              {busy && progress(row)}
            </View>
          );
        })}
      </ScreenSection>

      <View style={styles.group}>
        <SectionLabel>{t("mapsLeaving")}</SectionLabel>
        <View style={[styles.prompt, { backgroundColor: palette.groupBg }]}>
          <View style={styles.promptRow}>
            <View style={[styles.promptIcon, { backgroundColor: palette.accentA }]}>
              <Icon name="map" size={20} color={palette.accent} />
            </View>
            <View style={styles.copy}>
              <T w="semibold" size={15}>
                {t("regionOutsideTitle").replace("{region}", activeRow?.name ?? t("mapsKyiv"))}
              </T>
              <T size={13} color={palette.text2} style={styles.lead}>
                {t("mapsLeavingBody")}
              </T>
            </View>
          </View>
          <View style={styles.buttons}>
            <View style={[styles.button, { backgroundColor: palette.surface }]}>
              <T w="semibold" size={14} color={palette.text2} fit>
                {t("notNow")}
              </T>
            </View>
            <View style={[styles.button, { backgroundColor: palette.surface }]}>
              <T w="semibold" size={14} color={palette.accent} fit>
                {t("regionSwitch")}
              </T>
            </View>
          </View>
        </View>
      </View>

      <ExplainCard
        rows={[
          { label: t("mapsTipLabel"), text: t("mapsTip") },
          { label: t("mapsRoutesLabel"), text: t("mapsRoutes") },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  // The region's state beside its name while both fit; otherwise under it, on the right (a large text size).
  head: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 },
  copy: { flex: 1, minWidth: "55%", gap: 3 },
  row: { gap: 8, paddingVertical: 10 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  progress: { gap: 8 },
  actions: { flexDirection: "row", gap: 10 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
  group: { gap: 8 },
  prompt: { borderRadius: Radius.rL, padding: 16, gap: 12, borderCurve: "continuous" },
  promptRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  promptIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  lead: { lineHeight: 18 },
  // Side by side, equal, while both labels fit; otherwise stacked (a large text size, a long label).
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flexGrow: 1, minWidth: "40%", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18 },
});
