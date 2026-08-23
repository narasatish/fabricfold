import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/* Security headers on every response — same baseline large companies ship. */
const securityHeaders = [
  // Force HTTPS for 2 years, including subdomains (browsers remember)
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Never allow the app to be embedded in someone else's <iframe> (clickjacking)
  { key: "X-Frame-Options", value: "DENY" },
  // Never let the browser guess content types (MIME sniffing attacks)
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak full URLs to other sites
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The app never needs these browser powers — deny them outright
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  // Cross-origin isolation for popups/embeds
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  /* There is a stray package-lock.json in the user's home directory, so Next
     guesses the workspace root one level too high and warns on every start.
     Pin it: this folder IS the project. */
  turbopack: { root: __dirname },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

/* Sentry wrapper. Source-map upload only runs when SENTRY_AUTH_TOKEN + org/project
   are set (build stays green without them). Runtime capture is gated by the DSN. */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  // Route Sentry requests through our own domain to dodge ad-blockers
  tunnelRoute: "/monitoring-tunnel",
});
