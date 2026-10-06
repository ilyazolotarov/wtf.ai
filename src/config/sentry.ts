import * as Sentry from "@sentry/react-native";

import { deviceTags, sentryEnvironment, type MetricSink } from "@/services/telemetry";
import { scrubBreadcrumb, scrubEvent, scrubLog } from "./sentry-scrub";

// Crash and error reporting (SPEC §2 privacy exception). The DSN is a public client key.
export const SENTRY_DSN =
  "https://0bcf0358b74b501bcc05a79a0b3ee6a0@o4512190401937408.ingest.de.sentry.io/4512190411833424";

export function initSentry(): void {
  Sentry.init({
    dsn: SENTRY_DSN,
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
