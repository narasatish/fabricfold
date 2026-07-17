/* Digital Asset Links — proves fabricfold.in and the Android app are the same
   owner. Without a match, the TWA opens with a browser URL bar on top.

   TWA_SHA256_FINGERPRINTS: comma-separated SHA-256 cert fingerprints, e.g.
     "AA:BB:..:FF,11:22:..:99"
   Use the fingerprint Play Console shows under
   Release > Setup > App signing ("App signing key certificate"), because with
   Play App Signing Google re-signs the app with ITS key — the local upload key
   fingerprint alone is not enough. Include the upload key too for local test
   builds. Served fresh so a key rotation doesn't need a redeploy of the app. */

export const dynamic = "force-dynamic";

const PACKAGE_NAME = process.env.TWA_PACKAGE_NAME || "in.fabricfold.app";

export function GET() {
  const fingerprints = (process.env.TWA_SHA256_FINGERPRINTS || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const body = fingerprints.length
    ? [
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: PACKAGE_NAME,
            sha256_cert_fingerprints: fingerprints,
          },
        },
      ]
    : [];

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Google's verifier re-fetches this; keep it cheap but not stale.
      "Cache-Control": "public, max-age=300",
    },
  });
}
