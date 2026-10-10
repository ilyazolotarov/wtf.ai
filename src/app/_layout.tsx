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
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Platform, useColorScheme } from "react-native";

import { AnimatedSplash } from "@/components/animated-splash";
import { setSheetClosing } from "@/components/map/sheet-closing";
import { initSentry, Sentry } from "@/config/sentry";
import { Colors } from "@/constants/theme";
import { I18nProvider, useT } from "@/i18n/provider";
import { PositionProvider } from "@/providers/position-provider";
import { RuntimeProvider } from "@/providers/runtime-provider";
import { applyAppearance, loadAppearance } from "@/services/preferences";

initSentry();
// On iOS the override would redraw the native splash, still on screen, in the app's scheme: a light flash over a
// dark launch. There it is applied once the animated splash, drawn like the native one, has replaced it.
if (Platform.OS !== "ios") applyAppearance(loadAppearance());
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
      {/* Dark icons on the light theme, light on the dark one, following the app's scheme (Settings may fix it):
          Android drew white ones over the light map. */}
      <StatusBar style="auto" />
      <I18nProvider>
        <PositionProvider>
          <RuntimeProvider>
            <AppStack />
          </RuntimeProvider>
        </PositionProvider>
        {!splashDone && (
          <AnimatedSplash
            onNativeHidden={() => {
              if (Platform.OS === "ios") applyAppearance(loadAppearance());
            }}
            onDone={() => setSplashDone(true)}
          />
        )}
      </I18nProvider>
    </ThemeProvider>
  );
}

/**
 * Everything opened from the map is a page pushed on this one stack: it slides in from the right, and the system's
 * swipe from the left edge (or the header's back button) goes back a level (UI-SPEC §7).
 */
const PAGES = [
  "route",
  "vehicle",
  "downloads",
  "more/index",
  "more/downloads",
  "more/update",
  "more/settings",
  "more/position",
  "more/recorder",
  "more/developer",
  "more/ui-gallery",
  "guide/index",
  "guide/lesson",
] as const;

/** The map blurs while a page is over it (SheetBlur), un-blurring as soon as one starts going back. */
const BLUR_LISTENERS = {
  transitionStart: (e: { data: { closing: boolean } }) => setSheetClosing(e.data.closing),
  transitionEnd: () => setSheetClosing(false),
  gestureCancel: () => setSheetClosing(false),
};

function AppStack() {
  const { t } = useT();
  const palette = Colors[useColorScheme() === "dark" ? "dark" : "light"];

  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: palette.sheetBg } }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {PAGES.map((name) => (
        // Sliding in from the right on Android too (its back gesture and button go back there).
        <Stack.Screen key={name} name={name} listeners={BLUR_LISTENERS} options={{ headerShown: false, animation: "slide_from_right" }} />
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
        name="map-setup"
        options={{
          headerShown: false,
          presentation: "fullScreenModal",
          gestureEnabled: false,
          contentStyle: { backgroundColor: palette.bg },
        }}
      />
      {/* Developer pages with the system's header: its back button and swipe. */}
      <Stack.Screen name="debug-terminal" options={{ title: t("elmTerminal") }} />
      <Stack.Screen name="trips" options={{ title: t("trips") }} />
    </Stack>
  );
}
