/* Sentry — edge runtime (middleware/proxy). Env-gated like the server config. */
import * as Sentry from "@sentry/nextjs";
import { isExpectedAuthNoise } from "./lib/sentry-filter";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
    enableLogs: true,
    debug: false,
    beforeSend(event, hint) {
      if (isExpectedAuthNoise(hint)) return null;
      return event;
    },
  });
}
