import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";

import { deviceTags, sentryEnvironment, type MetricSink } from "@/services/telemetry";
import { scrubBreadcrumb, scrubEvent, scrubLog } from "./sentry-scrub";

// Crash and error reporting (SPEC §2 privacy exception). The DSN (a public client key) comes from the build's
// environment, SENTRY_DSN (app.config.js), so the source names no Sentry account. Without it nothing is sent.
export const SENTRY_DSN: string | null = (Constants.expoConfig?.extra as { sentryDsn?: string | null } | undefined)?.sentryDsn ?? null;

export function initSentry(): void {
  Sentry.init({
    dsn: SENTRY_DSN ?? undefined,
    enabled: SENTRY_DSN != null,
    // On in every build (Debug IPAs run without a Mac console); filter by environment in Sentry.
    // Emulator runs in CI report as "ci" so they never mix with testers' phones.
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
