"use client";
/* Shows the RIGHT platform's card first, and states plainly that iPhone has
   no one-tap download — Apple does not allow it, on any browser, on any iOS
   version. Saying so explicitly matters: without it, a 3-tap manual process
   reads as "the install button is broken" rather than "this is how every
   web app installs on an iPhone, including ones from Google and Meta". */
import { useEffect, useState } from "react";

function detectIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function PlatformInstructions() {
  const [ios, setIos] = useState<boolean | null>(null);
  useEffect(() => setIos(detectIos()), []);

  const iphoneCard = (
    <div className="card pad mt12" style={{ textAlign: "left" }}>
      <div className="h-sm">iPhone — 3 taps, no separate download</div>
      {ios && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 8 }}>
          Apple doesn&apos;t allow one-tap install from a browser on iPhone — every web
          app installs this way, including ones from Google and Meta. This is not
          a broken button; it&apos;s the real, complete path.
        </p>
      )}
      <ol className="muted" style={{ fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18, marginTop: 6 }}>
        <li>Open <b>fabricfold.in</b> in <b>Safari</b> (not Chrome — Chrome on iPhone can&apos;t add to Home Screen)</li>
        <li>Tap the <b>Share</b> button (square with an arrow, in the bottom toolbar)</li>
        <li>Scroll down and choose <b>Add to Home Screen</b></li>
        <li>Tap <b>Add</b> — FabricFold now opens like any other app</li>
      </ol>
    </div>
  );

  const androidCard = (
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
  );

  // Before detection resolves (first paint / no JS), show both in a stable
  // order rather than nothing — a student on a slow connection still sees
  // real instructions immediately.
  if (ios === null) return <>{iphoneCard}{androidCard}</>;
  return ios ? <>{iphoneCard}{androidCard}</> : <>{androidCard}{iphoneCard}</>;
}
