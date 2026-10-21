/* Sentry — browser runtime. Env-gated. Session Replay masks all text/inputs so
   no student PII (names, phones, order IDs) leaves the device in a replay.

   Found 2026-10-21: every page, even a static one with zero app data
   (/terms), threw a React hydration error (#418) in production. Traced it
   to Replay's own text-masking — its MutationObserver starts watching and
   rewriting DOM text the moment the integration is registered, and this
   file used to register it synchronously inside Sentry.init(), which Next's
   instrumentation-client convention runs as early as possible on purpose
   (so it can catch errors from the very first tick). That "as early as
   possible" timing is exactly what let it land inside React's hydration
   window: Replay mutates a text node before React finishes comparing
   server HTML to the client's first render, so React sees content it
   didn't produce and throws, discarding and rebuilding that subtree.
   Error capture itself was never the problem — only Replay's DOM-touching
   setup needs to wait. Sentry.init() still runs synchronously (so startup
   errors are still caught immediately); only the replay integration is
   added a macrotask later, after hydration has committed. */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
    enableLogs: true,
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1.0,
    debug: false,
  });

  if (typeof window !== "undefined") {
    setTimeout(() => {
      Sentry.addIntegration(Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }));
    }, 0);
  }
}

// Instruments client-side router navigations for tracing (no-op without a DSN).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
