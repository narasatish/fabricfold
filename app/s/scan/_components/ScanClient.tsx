"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import jsQR from "jsqr";
import { TopBar } from "@/components/chrome";

/* Camera-based QR scanner for staff: scan a student's QR (shown on their
   own profile, app/c/profile) and jump straight to app/s/customers/[id],
   skipping the "ask for ID, search, find the right row" lookup the owner
   described as the main counter bottleneck. jsQR (pure JS, no WASM) reads
   raw frames off a <video> via a hidden <canvas> — no native dependency,
   works in any PWA/TWA that has camera permission. */
export default function ScanClient() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        tick();
      } catch {
        setError("Camera access denied or unavailable. You can still search by ID below.");
      }
    }

    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(frame.data, frame.width, frame.height);
          if (code && code.data) {
            handleResult(code.data);
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function handleResult(text: string) {
      stopped = true;
      setScanning(false);
      stream?.getTracks().forEach((t) => t.stop());
      // The QR encodes a full /s/scan/{token} URL (see
      // app/c/profile/_components/MyQr.tsx) — token is a one-time,
      // short-lived code, not the student's id, so it must go through
      // that route (which looks it up, consumes it, and redirects) rather
      // than jumping straight to /s/customers/{token}.
      const match = text.match(/\/s\/scan\/([A-Za-z0-9]+)/);
      const token = match ? match[1] : null;
      if (token) {
        router.push(`/s/scan/${token}`);
      } else {
        setError("That QR code isn't a FabricFold student code.");
        setScanning(true);
      }
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="screen">
      <TopBar title="Scan student QR" back="/s" />
      <div className="pad">
        {error && (
          <div className="card pad mt16" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4" }}>
            <div style={{ color: "var(--amber)", fontSize: "13px" }}>{error}</div>
          </div>
        )}
        <div className="card mt16" style={{ overflow: "hidden", borderRadius: 14, position: "relative" }}>
          <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block", background: "#000" }} />
          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
        <div className="muted center mt16" style={{ fontSize: "12.5px" }}>
          {scanning ? "Point the camera at the student's QR code" : "Opening order…"}
        </div>
      </div>
    </div>
  );
}
