import type { NextConfig } from "next";

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
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
