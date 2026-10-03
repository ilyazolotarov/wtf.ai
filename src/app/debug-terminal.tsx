import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";

import { ScreenAction, ScreenContent, ScreenNote, ScreenSection } from "@/components/screens/screen-ui";
import { Colors } from "@/constants/theme";
import { useT } from "@/i18n/provider";
import { useRuntime, useVehicleLinkValue } from "@/providers/runtime-provider";

interface Entry {
  id: number;
  command: string;
  status: string;
  lines: string[];
  latencyMs: number;
}

const QUICK = ["ATI", "ATRV", "ATDPN", "STI", "0100", "010D", "010C", "0902"];

let nextId = 1;

/** Dev-only ELM terminal (TRIP-LOGGER-SPEC §9.3). Commands run with polling paused. */
export default function DebugTerminalScreen() {
  const { t } = useT();
  const { link } = useRuntime();
  const connected = useVehicleLinkValue((s) => s.activeDeviceId !== null && (s.link === "polling" || s.link === "standby"));
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);

  const run = async (cmd: string) => {
    const c = cmd.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      const r = await link.exclusive((send) => send(c, { timeoutMs: c.startsWith("09") ? 5000 : 2500 }));
      setLog((l) => [
        { id: nextId++, command: c, status: r.status, lines: r.lines, latencyMs: (r.rxUs - r.txUs) / 1000 },
        ...l,
      ].slice(0, 200));
    } catch (error) {
      setLog((l) => [{ id: nextId++, command: c, status: "error", lines: [String(error)], latencyMs: 0 }, ...l]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContent>
      <ScreenSection title={t("elmTerminal")} plain>
        <TextInput
          value={command}
          onChangeText={setCommand}
          placeholder={t("commandPlaceholder")}
          placeholderTextColor={palette.textSecondary}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={() => void run(command)}
          style={[styles.input, { color: palette.text, borderColor: palette.textSecondary }]}
        />
        <View style={styles.quick}>
          {QUICK.map((q) => (
            <Pressable key={q} onPress={() => void run(q)} disabled={!connected || busy} style={[styles.chip, { backgroundColor: palette.accentA }]}>
              <Text style={[styles.chipText, { color: palette.accent }]}>{q}</Text>
            </Pressable>
          ))}
        </View>
        <ScreenAction labelKey="send" disabled={!connected || busy} onPress={() => void run(command)} />
        <ScreenAction labelKey="clear" secondary onPress={() => setLog([])} />
      </ScreenSection>
      {!connected && <ScreenNote>{t("adapterDisconnected")}</ScreenNote>}
      {log.map((e) => (
        <View key={e.id} style={[styles.entry, { backgroundColor: palette.backgroundElement }]}>
          <Text style={[styles.mono, { color: palette.text }]}>
            {"> "}
            {e.command}
            <Text style={{ color: palette.textSecondary }}>{`   ${e.status} · ${e.latencyMs.toFixed(0)} ms`}</Text>
          </Text>
          {e.lines.map((line, i) => (
            <Text key={i} selectable style={[styles.mono, { color: palette.text }]}>
              {line}
            </Text>
          ))}
        </View>
      ))}
    </ScreenContent>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16, fontFamily: "Menlo" },
  quick: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  chipText: { fontWeight: "600", fontFamily: "Menlo" },
  entry: { padding: 12, borderRadius: 12, gap: 2 },
  mono: { fontFamily: "Menlo", fontSize: 13 },
});
