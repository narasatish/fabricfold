"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorScreen } from "@/components/error-reporter";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Sentry (no-op without a DSN); ErrorScreen also logs to our own /api/error.
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return <ErrorScreen error={error} reset={reset} />;
}
