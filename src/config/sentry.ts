import * as Sentry from "@sentry/react-native";
import * as Device from "expo-device";

import { deviceTags, sentryEnvironment, type MetricSink } from "@/services/telemetry";
import { extraString } from "./extra";
import { scrubBreadcrumb, scrubEvent, scrubLog } from "./sentry-scrub";

// Crash and error reporting (SPEC §2 privacy exception). The DSN (a public client key) comes from the build's
// environment, SENTRY_DSN (app.config.js), so the source names no Sentry account. Without it nothing is sent.
export const SENTRY_DSN: string | null = extraString("sentryDsn");

let started = false;

/** Once per JS runtime: the root layout calls it, and so does Android's wake task, which runs without a screen. */
export function initSentry(): void {
  if (started) return;
  started = true;
  Sentry.init({
    dsn: SENTRY_DSN ?? undefined,
    // Testers' phones only: an emulator or a debug build (Metro) is the developer's, and its errors mixed in with theirs
    // (2026-10-24: 185 events from a local emulator among a day's dozen).
    enabled: SENTRY_DSN != null && Device.isDevice && !__DEV__,
    environment: sentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: __DEV__ ? 1 : 0.1,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableLogs: true,
    enableMetrics: true,
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["log", "info", "warn", "error"] })],
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendLog: (log) => scrubLog(log),
  });
  // Which phone, Android version, build and install: on every event, log and metric (docs/ANDROID-SPEC.md §4.1).
  Sentry.setTags(deviceTags());
}

/** Metrics go to Sentry; a failure to report must never reach the app. */
export const sentryMetricSink: MetricSink = {
  count: (name, value, attrs) => report(() => Sentry.metrics.count(name, value, { attributes: attrs })),
  gauge: (name, value, attrs) => report(() => Sentry.metrics.gauge(name, value, { attributes: attrs })),
  distribution: (name, value, attrs) => report(() => Sentry.metrics.distribution(name, value, { attributes: attrs })),
};

function report(fn: () => void): void {
  try {
    fn();
  } catch {
    // telemetry is best effort
  }
}

export { Sentry };
