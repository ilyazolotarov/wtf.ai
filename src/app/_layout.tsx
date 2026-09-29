import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { useColorScheme } from "react-native";

import { I18nProvider, useT } from "@/i18n/provider";
import { PositionProvider } from "@/providers/position-provider";
import { RouteProvider } from "@/providers/route-provider";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      <I18nProvider>
        <PositionProvider>
          <RouteProvider>
            <AppStack />
          </RouteProvider>
        </PositionProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function AppStack() {
  const { t } = useT();
  const colorScheme = useColorScheme();

  return (
    <Stack
      screenOptions={{
        contentStyle: {
          backgroundColor: colorScheme === "dark" ? "#101A1D" : "#F4F5F2",
        },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="route"
        options={{
          title: t("route"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="vehicle"
        options={{
          title: t("vehicle"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="calibration"
        options={{
          title: t("calibration"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="downloads"
        options={{
          title: t("downloads"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="debug"
        options={{
          title: t("debug"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          title: t("settings"),
          presentation: "formSheet",
          sheetGrabberVisible: true,
        }}
      />
    </Stack>
  );
}
