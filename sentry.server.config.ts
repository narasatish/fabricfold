/* Sentry — server runtime. Fully env-gated: with no NEXT_PUBLIC_SENTRY_DSN
   set, Sentry.init is never called and the SDK is inert (no build/runtime
   impact). Runs alongside our own /api/error logger, not instead of it. */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Capture 100% in dev, 10% in production
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
    enableLogs: true,
    // Don't spam the console during local dev
    debug: false,
  });
}
