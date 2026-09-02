"use client";
/* Login screen — phone + OTP entry, customer/staff mode toggle.
   No self-registration: a student account can only be created by staff at
   the counter (see lib/actions/admin.ts registerStudent). An unrecognised
   customer number gets a clear message instead of a signup form. */
import { useState } from "react";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { requestOtp, verifyOtp, hasPasscode, loginWithPasscode } from "@/lib/actions/auth";
import { startWhatsAppLogin, checkWhatsAppLogin } from "@/lib/actions/wa-login";
import InstallHint from "@/components/install-hint";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"phone" | "otp" | "passcode" | "whatsapp">("phone");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [passcode, setPasscodeValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);

  const [waCode, setWaCode] = useState<string | null>(null);
  const waTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Poll while a WhatsApp sign-in is outstanding.

     Polling rather than a push: the student leaves the browser for WhatsApp
     and comes back, and a socket does not survive that on every phone. Two
     seconds is fast enough to feel instant on return and cheap enough at this
     scale — the window is five minutes at most. */
  useEffect(() => {
    if (!waCode) return;
    const stop = () => { if (waTimer.current) clearInterval(waTimer.current); waTimer.current = null; };
    waTimer.current = setInterval(async () => {
      const r = await checkWhatsAppLogin(waCode);
      if (r.ok && r.status === "pending") return;         // still waiting
      stop();
      setWaCode(null);
      if (r.ok && r.status === "signed-in") { toast("Signed in"); router.push("staff" in r && r.staff ? "/s" : "/c"); return; }
      if (!r.ok) { setStep("phone"); toast(r.error, true); }
    }, 2000);
    return stop;
  }, [waCode, router, toast]);

  const handleWhatsApp = async () => {
    setLoading(true);
    const r = await startWhatsAppLogin(mode);
    setLoading(false);
    if (!r.ok) { toast(r.error, true); return; }
    /* Opened BEFORE we start polling, and in the same tick as the tap: a
       popup opened from an async callback is blocked on iOS Safari. */
    window.open(r.link, "_blank", "noopener");
    setWaCode(r.code);
    setStep("whatsapp");
  };

  /* Students who have set a passcode go straight to it — no waiting for a text,
     and it works where the signal doesn't. Staff stay OTP-only: a staff account
     takes payments, so it should not be reachable by a guessable passcode. */
  const handleContinue = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    if (mode === "staff") return handleRequestOtp();
    setLoading(true);
    const r = await hasPasscode(phone);
    setLoading(false);
    if (r.hasPasscode) { setStep("passcode"); return; }
    return handleRequestOtp();
  };

  const handlePasscodeLogin = async () => {
    setLoading(true);
    const r = await loginWithPasscode(phone, passcode);
    setLoading(false);
    if (!r.ok) { toast(r.error, true); return; }
    toast("Signed in");
    router.push("/c");
  };

  const handleRequestOtp = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    setLoading(true);
    setNotRegistered(false);
    const r = await requestOtp(phone, mode);
    setLoading(false);
    if (!r.ok) {
      toast(r.error, true);
      return;
    }
    setStep("otp");
    toast("OTP sent to +91 " + phone.slice(-10));
  };

  const handleVerifyOtp = async () => {
    if (otp.trim().length !== 6) {
      toast("Enter 6-digit OTP", true);
      return;
    }
    setLoading(true);
    const r = await verifyOtp(phone, otp, mode);
    setLoading(false);

    if (!r.ok) {
      if (mode === "customer" && /isn't registered/i.test(r.error)) {
        setNotRegistered(true);
        return;
      }
      toast(r.error, true);
      return;
    }
    toast("Signed in");
    router.push(mode === "customer" ? "/c" : "/s");
  };

  return (
    <div className="screen no-nav">
      <div className="topbar">
        <h1>FabricFold</h1>
      </div>

      <div className="pad" style={{ paddingTop: "24px" }}>
        {step === "phone" && (
          <>
            {/* The logo carries its own wordmark, so it replaces the lettered
                gradient card rather than sitting on top of one — the artwork's
                pale sky would have fought the teal. Width and height are set on
                the element so the box is reserved before the image arrives:
                this is the first paint of the first screen, and a logo popping
                in would push the sign-in field down under the user's thumb. */}
            <div style={{ textAlign: "center", marginBottom: "20px" }}>
              <img
                src="/logo-full.png"
                alt="FabricFold"
                width={132}
                height={132}
                style={{ borderRadius: "22px", boxShadow: "0 8px 24px rgba(14,146,113,.18)" }}
              />
              <div style={{ fontSize: "12px", color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginTop: "12px" }}>
                Campus laundry &amp; dry-cleaning
              </div>
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label className="label">Sign in as:</label>
              <div className="seg" style={{ marginTop: "8px" }}>
                <button className={mode === "customer" ? "active" : ""} onClick={() => setMode("customer")}>
                  Customer
                </button>
                <button className={mode === "staff" ? "active" : ""} onClick={() => setMode("staff")}>
                  Staff
                </button>
              </div>
            </div>

            <div className="field">
              <label>Mobile number</label>
              <input
                className="input"
                type="tel"
                placeholder="10-digit number"
                autoFocus
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                onKeyDown={(e) => { if (e.key === "Enter" && phone.length === 10 && !loading) handleContinue(); }}
                inputMode="numeric"
              />
            </div>
            <button className="btn" onClick={handleContinue} disabled={loading || phone.length !== 10}>
              {loading ? "Checking…" : "Continue"}
            </button>

            {/* Both doors now (owner, Sep 2026): staff too. The server still
                checks the number against the admin-managed roster, so
                WhatsApp changes the handshake, not who gets in. (Wording
                note: dual-identity.test.ts bans naming that roster here.) */}
            <div className="row center mt16" style={{ gap: 10, color: "var(--ink-2)", fontSize: 12 }}>
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />or<span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
            <button className="btn sec mt12" onClick={handleWhatsApp} disabled={loading}
              style={{ color: "#0f8a4d", borderColor: "#bfe6cf" }}>
              Continue with WhatsApp
            </button>
            <div className="muted center mt8" style={{ fontSize: "12px" }}>
              No code to wait for — send one message and you&apos;re in.
            </div>

            {mode === "customer" && (
              <div className="muted center mt16" style={{ fontSize: "12.5px", lineHeight: 1.5 }}>
                New here? Visit your campus counter to get registered. Staff sign in on the Staff tab above.
              </div>
            )}

            {/* A QR scan can land here instead of /get — the download must
                still be one tap away (owner, after scanning the poster). */}
            <InstallHint />
          </>
        )}

        {step === "whatsapp" && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>Waiting for your message</div>
            <div className="muted" style={{ fontSize: "13px", lineHeight: 1.6, marginBottom: "18px" }}>
              WhatsApp should have opened with a message already typed. Press <b>send</b> and this
              page signs you in by itself — nothing to type back here.
            </div>

            {/* The code is shown because WhatsApp may not have opened at all —
                a blocked popup, or no WhatsApp on a desktop browser. Seeing it
                means the student can still message us manually. */}
            <div className="card" style={{ textAlign: "center", padding: "18px" }}>
              <div className="muted" style={{ fontSize: 12 }}>Your code</div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: ".12em", fontFamily: "ui-monospace, monospace" }}>{waCode}</div>
            </div>

            <div className="row center mt16" style={{ gap: 8 }}>
              <div className="spinner" style={{ width: 16, height: 16 }} />
              <span className="muted" style={{ fontSize: 13 }}>Waiting…</span>
            </div>

            <button className="btn ghost mt16" onClick={() => { setWaCode(null); setStep("phone"); }}>
              Use my number instead
            </button>
          </>
        )}

        {step === "passcode" && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>Enter your passcode</div>
            <div className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
              +91 {phone.slice(-10)}{" "}
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => { setStep("phone"); setPasscodeValue(""); }}>
                Change
              </span>
            </div>
            <div className="field">
              <label>Passcode</label>
              <input
                className="input"
                type="password"
                placeholder="Your passcode"
                autoFocus
                value={passcode}
                onChange={(e) => setPasscodeValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && passcode && !loading) handlePasscodeLogin(); }}
              />
            </div>
            <button className="btn" onClick={handlePasscodeLogin} disabled={loading || !passcode}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
            {/* Always reachable: a forgotten or locked passcode must never be a
                dead end, and the phone is the thing we can actually verify. */}
            <button
              className="btn sec mt12"
              onClick={() => { setPasscodeValue(""); handleRequestOtp(); }}
              disabled={loading}
            >
              Forgot passcode — sign in with OTP
            </button>
          </>
        )}

        {step === "otp" && !notRegistered && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>
              Enter OTP
            </div>
            <div className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
              Sent to +91 {phone.slice(-10)}{" "}
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => setStep("phone")}>
                Change
              </span>
            </div>

            {process.env.NODE_ENV === "development" && (
              <div className="card pad mt12 center" style={{ background: "var(--teal-tint)", borderColor: "var(--teal-soft)" }}>
                <div className="label" style={{ color: "var(--teal-dark)" }}>
                  Dev OTP
                </div>
                <div className="otp-box mt8" style={{ fontSize: "38px", fontWeight: 750, letterSpacing: ".18em" }}>
                  123456
                </div>
              </div>
            )}

            <div className="field mt16">
              <label>6-digit code</label>
              <input
                className="input"
                type="text"
                placeholder="••••••"
                autoFocus
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter" && otp.length === 6 && !loading) handleVerifyOtp(); }}
                inputMode="numeric"
                maxLength={6}
                style={{ letterSpacing: ".3em", fontSize: "18px" }}
              />
            </div>
            <button className="btn" onClick={handleVerifyOtp} disabled={loading || otp.length !== 6}>
              {loading ? "Verifying…" : "Verify & sign in"}
            </button>
            <button className="btn sec mt10" onClick={() => handleRequestOtp()}>
              Resend OTP
            </button>
          </>
        )}

        {step === "otp" && notRegistered && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>
              Not registered yet
            </div>
            <div className="card pad" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4", marginBottom: "16px" }}>
              <div className="row gap8">
                <span style={{ color: "var(--amber)" }}>
                  <Svg name="alert" size={20} />
                </span>
                <div style={{ color: "var(--amber)", fontSize: "13px", lineHeight: 1.5 }}>
                  +91 {phone.slice(-10)} isn't registered. Please visit your campus counter — staff will register you in
                  a moment, then you can sign in with just your number and a one-time code.
                </div>
              </div>
            </div>
            <button className="btn sec" onClick={() => { setStep("phone"); setNotRegistered(false); setOtp(""); }}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
