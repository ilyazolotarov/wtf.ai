import {
  Onest_300Light,
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
  Onest_700Bold,
  useFonts,
} from "@expo-google-fonts/onest";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useState } from "react";
import { useColorScheme } from "react-native";

import { AnimatedSplash } from "@/components/animated-splash";
import { setSheetClosing } from "@/components/map/sheet-closing";
import { initSentry, Sentry } from "@/config/sentry";
import { Colors } from "@/constants/theme";
import { I18nProvider, useT } from "@/i18n/provider";
import { PositionProvider } from "@/providers/position-provider";
import { RuntimeProvider } from "@/providers/runtime-provider";
import { applyAppearance, loadAppearance } from "@/services/preferences";

initSentry();
applyAppearance(loadAppearance());
void SplashScreen.preventAutoHideAsync();

export default Sentry.wrap(RootLayout);

function RootLayout() {
  const colorScheme = useColorScheme();
  const [fontsLoaded, fontError] = useFonts({
    Onest_300Light,
    Onest_400Regular,
    Onest_500Medium,
    Onest_600SemiBold,
    Onest_700Bold,
  });
  const ready = fontsLoaded || fontError != null;
  // The animated overlay takes over from the native splash and hides it.
  const [splashDone, setSplashDone] = useState(false);

  if (!ready) return null;

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <I18nProvider>
        <PositionProvider>
          <RuntimeProvider>
            <AppStack />
          </RuntimeProvider>
        </PositionProvider>
        {!splashDone && <AnimatedSplash onDone={() => setSplashDone(true)} />}
      </I18nProvider>
    </ThemeProvider>
  );
}

const SHEETS = [
  "route",
  "vehicle",
  "more",
  "calibration",
  "downloads",
  "settings",
] as const;

function AppStack() {
  const { t } = useT();
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];

  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: palette.sheetBg } }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {SHEETS.map((name) => (
        <Stack.Screen
          key={name}
          name={name}
          listeners={{
            transitionStart: (e) => setSheetClosing(e.data.closing),
            transitionEnd: () => setSheetClosing(false),
            gestureCancel: () => setSheetClosing(false),
          }}
          options={{
            headerShown: false,
            presentation: "formSheet",
            sheetGrabberVisible: true,
            sheetCornerRadius: 32,
            sheetAllowedDetents: name === "more" ? [0.5] : [0.86],
          }}
        />
      ))}
      <Stack.Screen
        name="onboarding"
        options={{
          headerShown: false,
          presentation: "fullScreenModal",
          gestureEnabled: false,
          contentStyle: { backgroundColor: palette.bg },
        }}
      />
      <Stack.Screen
        name="debug-terminal"
        options={{ title: t("elmTerminal"), presentation: "modal" }}
      />
      <Stack.Screen
        name="trips"
        options={{ title: t("trips"), presentation: "modal" }}
      />
    </Stack>
  );
}
