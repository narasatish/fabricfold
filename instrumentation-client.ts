/* Sentry — browser runtime. Env-gated. Session Replay masks all text/inputs so
   no student PII (names, phones, order IDs) leaves the device in a replay. */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
    enableLogs: true,
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
    ],
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1.0,
    debug: false,
  });
}

// Instruments client-side router navigations for tracing (no-op without a DSN).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
