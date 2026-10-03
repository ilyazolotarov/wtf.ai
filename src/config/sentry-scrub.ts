// Privacy scrubbing for Sentry events (SPEC §2 privacy exception, §9).
// Pure TS so it is unit-testable. Never let positions or VINs leave the device.

/** Decimal degrees with ≥ 3 fractional digits (≈ 100 m) look like coordinates. */
const COORDINATE = /-?\b\d{1,3}\.\d{3,}\b/g;
/** ISO 3779 VIN: 17 chars, no I/O/Q. */
const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
/** Keys whose values are always dropped. */
const SENSITIVE_KEYS = /^(lat|lon|lng|latitude|longitude|latDeg|lonDeg|coords?|position|location|vin|vehicle_vin|rawGnss)$/i;

export function scrubText(text: string): string {
  return text.replace(VIN, "[vin]").replace(COORDINATE, "[num]");
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number") {
    // Bare coordinates in numeric fields: keep integers and short decimals, drop high-precision floats.
    return Number.isInteger(value) || Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? value : "[num]";
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

interface ScrubbableEvent {
  message?: string;
  exception?: { values?: { value?: string }[] };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: ScrubbableBreadcrumb[];
  user?: unknown;
}

interface ScrubbableBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T {
  return {
    ...crumb,
    message: crumb.message === undefined ? undefined : scrubText(crumb.message),
    data: crumb.data === undefined ? undefined : (scrubValue(crumb.data) as Record<string, unknown>),
  };
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  return {
    ...event,
    user: undefined,
    message: event.message === undefined ? undefined : scrubText(event.message),
    exception: event.exception && {
      ...event.exception,
      values: event.exception.values?.map((v) => ({ ...v, value: v.value === undefined ? undefined : scrubText(v.value) })),
    },
    extra: event.extra === undefined ? undefined : (scrubValue(event.extra) as Record<string, unknown>),
    contexts: event.contexts === undefined ? undefined : (scrubValue(event.contexts) as Record<string, unknown>),
    breadcrumbs: event.breadcrumbs?.map((b) => scrubBreadcrumb(b)),
  };
}
