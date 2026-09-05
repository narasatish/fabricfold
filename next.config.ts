import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/* React's dev-mode debugging (call-stack reconstruction) uses eval(), which a
   strict script-src blocks outright — confirmed live in the browser: dev
   mode throws "eval() is not supported" and React never rendered past that.
   React's own docs say production never calls eval(), so this is scoped to
   development only — production keeps the stricter policy with no eval. */
const scriptSrc = process.env.NODE_ENV === "production"
  ? "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com";

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
  /* Content-Security-Policy — an explicit allowlist of where scripts, frames
     and connections may come from, on top of the headers above.

     'unsafe-inline' stays in script-src and style-src rather than a stricter
     nonce-based policy: Next's App Router bootstrap emits inline scripts, and
     this app uses React inline `style={{}}` throughout (not a CSS-in-JS
     library with nonce support), so a strict policy would break the app on
     day one without a separate nonce-per-request middleware. This CSP still
     does real work — it blocks loading attacker JS/frames from any domain
     that isn't explicitly named below, which is the common XSS payload this
     app would actually see (a compromised dependency or injected <script src>
     pointing off-site). It does not stop inline-script injection; that needs
     the nonce work as a follow-up if it's ever wanted.

     Razorpay is the one third-party script the app loads client-side
     (checkout.razorpay.com, PayClient.tsx) — its checkout flow also opens an
     iframe and calls out to api.razorpay.com and lumberjack.razorpay.com
     (its own analytics beacon), so those are explicitly allowed too; nothing
     else external is. */
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.razorpay.com",
      "font-src 'self' data:",
      // Sentry's browser SDK spins up a Web Worker (from a blob: URL) for
      // background stack processing; with no worker-src set, that fell back
      // to script-src, which doesn't allow blob:, and the browser silently
      // blocked it — confirmed live via a real console CSP violation.
      "worker-src 'self' blob:",
      "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
      "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
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
