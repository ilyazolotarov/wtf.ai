import * as Sentry from "@sentry/react-native";

import { scrubBreadcrumb, scrubEvent, scrubLog } from "./sentry-scrub";

// Crash and error reporting (SPEC §2 privacy exception). The DSN is a public client key.
export const SENTRY_DSN =
  "https://0bcf0358b74b501bcc05a79a0b3ee6a0@o4512190401937408.ingest.de.sentry.io/4512190411833424";

export function initSentry(): void {
  Sentry.init({
    dsn: SENTRY_DSN,
    // On in every build (Debug IPAs run without a Mac console); filter by environment in Sentry.
    environment: __DEV__ ? "development" : "production",
    sendDefaultPii: false,
    tracesSampleRate: __DEV__ ? 1 : 0.1,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableLogs: true,
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["log", "info", "warn", "error"] })],
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendLog: (log) => scrubLog(log),
  });
}

export { Sentry };
