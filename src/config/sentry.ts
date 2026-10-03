import * as Sentry from "@sentry/react-native";

import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

// Crash and error reporting (SPEC §2 privacy exception). The DSN is a public client key.
export const SENTRY_DSN =
  "https://0bcf0358b74b501bcc05a79a0b3ee6a0@o4512190401937408.ingest.de.sentry.io/4512190411833424";

export function initSentry(): void {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Off in Metro-served debug builds; on in standalone (Release) builds.
    enabled: !__DEV__,
    environment: __DEV__ ? "development" : "production",
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  });
}

export { Sentry };
