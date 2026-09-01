/* The install page — where the printed QR poster points.

   One URL for every phone: Android is offered the APK, iPhone the
   Add-to-Home-Screen path, and either way the sign-in button is right there.
   Detection is client-side and best-effort; both paths stay visible so a
   student helping a friend with the other kind of phone isn't stuck. */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Get the FabricFold app",
  description: "Install FabricFold on your phone — track your laundry, get pickup alerts, sign in with WhatsApp.",
  robots: { index: false }, // a poster target, not a search destination
};

export default function GetAppPage() {
  return (
    <div className="screen no-nav" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="pad" style={{ paddingTop: 28, textAlign: "center" }}>
        <img src="/logo-full.png" alt="FabricFold" width={96} height={96} style={{ borderRadius: 18 }} />
        <h1 className="h-lg" style={{ marginTop: 14 }}>Get FabricFold</h1>
        <p className="muted" style={{ fontSize: 14, marginTop: 6 }}>
          Track your laundry, get a ping when it&apos;s ready, sign in with one WhatsApp message.
        </p>

        <div className="card pad mt16" style={{ textAlign: "left" }}>
          <div className="h-sm">iPhone</div>
          <ol className="muted" style={{ fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18, marginTop: 6 }}>
            <li>Open <b>fabricfold.in</b> in Safari</li>
            <li>Tap the <b>Share</b> button</li>
            <li>Choose <b>Add to Home Screen</b></li>
          </ol>
        </div>

        <div className="card pad mt12" style={{ textAlign: "left" }}>
          <div className="h-sm">Android</div>
          <ol className="muted" style={{ fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18, marginTop: 6 }}>
            <li>Open <b>fabricfold.in</b> in Chrome</li>
            <li>Tap <b>Install app</b> when Chrome offers it (menu ⋮ → &quot;Add to Home screen&quot; if it doesn&apos;t)</li>
          </ol>
          {/* No hosted APK link — the APK is built and sideloaded at the
              counter (BUILD-APK.md). The installable PWA above IS the app,
              and it auto-updates on every deploy, which the APK does not. */}
        </div>

        <Link className="btn mt16" href="/login">
          Sign in now
        </Link>
        <p className="muted mt12" style={{ fontSize: 12.5 }}>
          Not registered yet? Visit your campus counter first — it takes a minute.
        </p>
      </div>
    </div>
  );
}
