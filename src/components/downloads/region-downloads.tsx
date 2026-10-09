import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";

import {
    ScreenAction,
    ScreenCard,
    ScreenLink,
    ScreenNote,
    ScreenSection,
} from "@/components/screens/screen-ui";
import { Icon, type IconName } from "@/components/ui/icon";
import { T } from "@/components/ui/text";
import { usePalette } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import {
    cancelDownload,
    downloadRegion,
    type MapDownload,
    getCatalogUrl,
    loadCatalog,
    pauseDownload,
    regionNeedsUpdate,
    removeRegion,
    resumeDownload,
    setActiveRegion,
    setCatalogUrl,
    useMapPacks,
} from "@/services/offline-map/map-packs";

export const formatMb = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`;

interface RegionRow {
  region: string;
  name: { en: string; uk: string };
  size: number;
  available: boolean;
}


export function IconButton({ icon, label, danger, filled, onPress }: { icon: IconName; label: string; danger?: boolean; filled?: boolean; onPress(): void }) {
  const palette = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: filled ? palette.accent : palette.surface }, pressed && { opacity: 0.6 }]}
    >
      <Icon name={icon} size={18} color={filled ? palette.onAccent : danger ? palette.bad.c : palette.accent} />
    </Pressable>
  );
}

/** Progress text, bar and pause/resume/cancel controls of the running download. */
function DownloadProgress({ download }: { download: MapDownload }) {
  const { t } = useT();
  const palette = usePalette();
  return (
    <View style={styles.progress}>
      <T size={13} color={palette.text2}>
        {download.phase === "paused"
          ? t("paused") + (download.bytes ? ` · ${formatMb(download.bytes)} / ${formatMb(download.total)}` : "")
          : download.phase === "verifying"
            ? t("verifying")
            : `${t("downloading")} ${formatMb(download.bytes)} / ${formatMb(download.total)}`}
      </T>
      <View style={[styles.bar, { backgroundColor: palette.surface }]}>
        <View
          style={[
            styles.barFill,
            {
              backgroundColor: palette.accent,
              width: `${download.total ? Math.min(100, (100 * download.bytes) / download.total) : 0}%`,
            },
          ]}
        />
      </View>
      <View style={styles.actions}>
        {download.phase !== "paused" && (
          <ScreenAction labelKey="pause" compact secondary onPress={pauseDownload} />
        )}
        {download.phase === "paused" && (
          <ScreenAction labelKey="resume" compact onPress={() => void resumeDownload()} />
        )}
        {download.phase !== "verifying" && <ScreenAction labelKey="cancel" compact secondary onPress={cancelDownload} />}
      </View>
    </View>
  );
}

/**
 * Offline maps (SPEC §3.8): regions from the newest GitHub map release (or a custom catalog
 * URL, e.g. `tiles serve` on a PC), downloaded one at a time; one installed region is active.
 * Each region bundles its road graph and search index; progress and pause/cancel controls show
 * in the region's row. The body of the Downloads sheet and of the first-run `map-setup` screen.
 */
export function RegionDownloads() {
  const { t, language } = useT();
  const palette = usePalette();
  const { installed, catalog, catalogLoading, catalogError, download, downloadError } = useMapPacks();
  const [source, setSource] = useState(getCatalogUrl);

  useEffect(() => {
    if (!catalog) void loadCatalog();
  }, [catalog]);

  // Catalog regions plus installed ones (so they stay manageable offline); Ukraine first.
  const rows = new Map<string, RegionRow>();
  // Sizes include the road graph that comes with the tiles.
  for (const r of catalog?.regions ?? []) rows.set(r.region, { ...r, size: r.size + (r.graph?.size ?? 0) + (r.search?.size ?? 0), available: true });
  for (const r of Object.values(installed.regions)) {
    if (!rows.has(r.region)) rows.set(r.region, { ...r, size: r.size + (r.graph?.size ?? 0) + (r.search?.size ?? 0), available: false });
  }
  const sorted = [...rows.values()].sort((a, b) =>
    a.region === "ukraine" ? -1 : b.region === "ukraine" ? 1 : a.name[language].localeCompare(b.name[language], language),
  );
  const active = installed.active ? installed.regions[installed.active] : null;
  const activeOutdated =
    !!active && !!catalog && regionNeedsUpdate(installed, catalog, active.region);
  const activeBusy = !!download && download.region === installed.active;

  // Switching to a region also brings it up to date, if the catalog has a newer version.
  const switchRegion = (region: string) => {
    setActiveRegion(region);
    if (catalog && !download && regionNeedsUpdate(installed, catalog, region)) void downloadRegion(region);
  };

  const applySource = () => {
    setCatalogUrl(source);
    void loadCatalog();
  };

  return (
    <>
      <ScreenCard style={styles.card}>
        <View style={styles.head}>
          <View style={styles.copy}>
            <T w="semibold" size={16}>
              {active ? active.name[language] : t("mapTiles")}
            </T>
            <T size={12} color={palette.text2}>
              {active
                ? [formatMb(active.size + (active.graph?.size ?? 0) + (active.search?.size ?? 0)), `OSM ${active.osm_date}`, !active.graph && t("noRoadData"), activeOutdated && t("updateAvailable")]
                    .filter(Boolean)
                    .join(" · ")
                : t("noMapYet")}
            </T>
          </View>
          {activeOutdated && !download ? (
            <IconButton icon="sync" filled label={t("update")} onPress={() => void downloadRegion(active.region)} />
          ) : (
            <T w="semibold" size={13} color={active ? palette.ok.c : palette.text2}>
              {active ? t("readyOffline") : t("notDownloaded")}
            </T>
          )}
        </View>
        {activeBusy && download && <DownloadProgress download={download} />}
      </ScreenCard>

      {downloadError && <ScreenNote color={palette.bad.c}>{downloadError}</ScreenNote>}

      <ScreenSection title={catalog ? `${t("mapRegions")} · OSM ${catalog.osm_date}` : t("mapRegions")}>
        {catalogLoading && sorted.length === 0 && (
          <View style={styles.row}>
            <ActivityIndicator />
          </View>
        )}
        {sorted.map((row) => {
          const have = installed.regions[row.region];
          const isActive = installed.active === row.region;
          const busy = download?.region === row.region;
          return (
            <View key={row.region} style={styles.row}>
              <View style={styles.rowHead}>
                <Pressable
                  style={styles.copy}
                  disabled={!have || isActive}
                  onPress={() => switchRegion(row.region)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t("useMap")}: ${row.name[language]}`}
                >
                  <T w={isActive ? "semibold" : "regular"} size={15}>
                    {row.name[language]}
                  </T>
                  <T size={12} color={isActive ? palette.ok.c : palette.text2}>
                    {[
                      formatMb(row.size),
                      have && (isActive ? t("activeMap") : t("downloaded")),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </T>
                </Pressable>
                {!download && row.available && !have && (
                  <IconButton icon="download" label={t("download")} onPress={() => void downloadRegion(row.region)} />
                )}
                {have && !busy && (
                  <IconButton icon="delete" danger label={t("delete")} onPress={() => removeRegion(row.region)} />
                )}
              </View>
              {busy && !isActive && download && <DownloadProgress download={download} />}
            </View>
          );
        })}
      </ScreenSection>
      {catalogError && (
        <View style={styles.errorRow}>
          <ScreenNote color={palette.bad.c}>{catalogError}</ScreenNote>
          <ScreenLink label={t("retry")} onPress={() => void loadCatalog()} />
        </View>
      )}

      <ScreenCard style={styles.card}>
        <T w="semibold" size={14}>
          {t("catalogSource")}
        </T>
        <TextInput
          value={source}
          onChangeText={setSource}
          onSubmitEditing={applySource}
          placeholder={t("catalogSourceGithub")}
          placeholderTextColor={palette.text2}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          style={[styles.input, { color: palette.text, backgroundColor: palette.surface }]}
        />
        <ScreenAction labelKey="apply" compact secondary onPress={applySource} />
        <ScreenNote>{t("catalogSourceNote")}</ScreenNote>
      </ScreenCard>
    </>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  copy: { flex: 1, gap: 3 },
  row: { gap: 8, paddingVertical: 10 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  progress: { gap: 8 },
  actions: { flexDirection: "row", gap: 10 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  input: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
});
