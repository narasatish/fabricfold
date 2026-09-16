"use client";
/* St Mary's campus QR entry point (Sep 2026).

   Unlike BVRIT, St Mary's has no self-registration — a new St Mary's
   student is registered by staff at the counter (lib/actions/admin.ts
   registerStudent), same as always. This page is sign-in ONLY: a
   campus-branded copy of /login's hero flow (customer WhatsApp + passcode
   fallback, staff WhatsApp), so the same physical QR sticker works for
   every returning customer and every staff member at this campus, without
   sending anyone through the generic, unbranded /login.

   Reuses startWhatsAppLogin/checkWhatsAppLogin/hasPasscode/loginWithPasscode
   UNCHANGED — the exact actions /login already calls. They take no
   collegeId, so an Admin/Owner signing in here still gets the SAME
   cross-campus account /login would have given them; there is no second
   copy of that scoping logic to drift out of sync. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { requestOtp, verifyOtp, hasPasscode, loginWithPasscode } from "@/lib/actions/auth";
import { startWhatsAppLogin, checkWhatsAppLogin } from "@/lib/actions/wa-login";
import InstallHint from "@/components/install-hint";

interface SignInFormProps {
  collegeName: string;
}

export default function SignInForm({ collegeName }: SignInFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"hero" | "otp" | "passcode" | "whatsapp">("hero");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [showPhone, setShowPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [passcode, setPasscodeValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);

  const [waCode, setWaCode] = useState<string | null>(null);
  const waTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!waCode) return;
    const stop = () => { if (waTimer.current) clearInterval(waTimer.current); waTimer.current = null; };
    waTimer.current = setInterval(async () => {
      const r = await checkWhatsAppLogin(waCode);
      if (r.ok && r.status === "pending") return;
      stop();
      setWaCode(null);
      if (r.ok && r.status === "signed-in") { toast("Signed in"); router.push("staff" in r && r.staff ? "/s" : "/c"); return; }
      if (!r.ok) { setStep("hero"); toast(r.error, true); }
    }, 2000);
    return stop;
  }, [waCode, router, toast]);

  const handleWhatsApp = async () => {
    setLoading(true);
    try {
      const r = await startWhatsAppLogin(mode);
      if (!r.ok) { toast(r.error, true); return; }
      window.open(r.link, "_blank", "noopener");
      setWaCode(r.code);
      setStep("whatsapp");
    } catch (e) {
      toast((e as Error).message || "Failed to start login", true);
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    setLoading(true);
    try {
      const r = await hasPasscode(phone);
      if (r.hasPasscode) { setStep("passcode"); return; }
      setShowPhone(false);
      toast("No passcode set for this number yet — tap Continue with WhatsApp", true);
    } catch (e) {
      toast((e as Error).message || "Failed to check passcode", true);
    } finally {
      setLoading(false);
    }
  };

  const handlePasscodeLogin = async () => {
    setLoading(true);
    try {
      const r = await loginWithPasscode(phone, passcode);
      if (!r.ok) { toast(r.error, true); return; }
      toast("Signed in");
      router.push("/c");
    } catch (e) {
      toast((e as Error).message || "Failed to sign in", true);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestOtp = async () => {
    setLoading(true);
    setNotRegistered(false);
    try {
      const r = await requestOtp(phone, "customer");
      if (!r.ok) {
        toast(r.error, true);
        return;
      }
      setStep("otp");
      toast("OTP sent to +91 " + phone.slice(-10));
    } catch (e) {
      toast((e as Error).message || "Failed to request OTP", true);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otp.trim().length !== 6) {
      toast("Enter 6-digit OTP", true);
      return;
    }
    setLoading(true);
    try {
      const r = await verifyOtp(phone, otp, "customer");

      if (!r.ok) {
        if (/isn't registered/i.test(r.error)) {
          setNotRegistered(true);
          return;
        }
        toast(r.error, true);
        return;
      }
      toast("Signed in");
      router.push("/c");
    } catch (e) {
      toast((e as Error).message || "Failed to verify OTP", true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="screen no-nav">
      <div className="topbar">
        <h1>FabricFold</h1>
        {step === "hero" && (
          <button
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-2)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 4px" }}
            onClick={() => { setMode(mode === "staff" ? "customer" : "staff"); setShowPhone(false); }}
          >
            {mode === "staff" ? "← Customer" : "Staff sign-in"}
          </button>
        )}
      </div>

      <div className="pad" style={{ paddingTop: "24px" }}>
        {step === "hero" && (
          <>
            <div style={{ textAlign: "center", marginBottom: "24px" }}>
              <img
                src="/logo-full-264.png"
                alt="FabricFold"
                width={132}
                height={132}
                style={{ borderRadius: "22px", boxShadow: "0 8px 24px rgba(14,146,113,.18)" }}
              />
              <div style={{ fontSize: "12px", color: "var(--ink-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", marginTop: "12px" }}>
                Campus laundry &amp; dry-cleaning
              </div>
            </div>

            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, textAlign: "center" }}>{collegeName} sign-in</h2>

            {mode === "customer" ? (
              <>
                <button className="btn" onClick={handleWhatsApp} disabled={loading} style={{ fontSize: 17, height: 54 }}>
                  {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                </button>
                <div className="muted center mt8" style={{ fontSize: "12.5px" }}>
                  No code to wait for — send one message and you&apos;re in.
                </div>

                {!showPhone ? (
                  <button
                    className="muted center mt20"
                    style={{ display: "block", width: "100%", background: "none", border: "none", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3, cursor: "pointer" }}
                    onClick={() => setShowPhone(true)}
                  >
                    Have a passcode? Sign in with your number
                  </button>
                ) : (
                  <div className="mt20">
                    <div className="field">
                      <label htmlFor="phone-input">Mobile number</label>
                      <input
                        id="phone-input"
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
                    <button className="btn sec" onClick={handleContinue} disabled={loading || phone.length !== 10}>
                      {loading ? "Checking…" : "Continue"}
                    </button>
                  </div>
                )}

                <div className="muted center mt20" style={{ fontSize: "12.5px", lineHeight: 1.5 }}>
                  New here? Visit your campus counter to get registered.
                </div>
              </>
            ) : (
              <>
                <button className="btn" onClick={handleWhatsApp} disabled={loading} style={{ fontSize: 17, height: 54 }}>
                  {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                </button>
                <div className="muted center mt8" style={{ fontSize: "12.5px" }}>
                  Registered staff numbers only — ask the owner if yours isn&apos;t working.
                </div>
              </>
            )}

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

            <div className="card" style={{ textAlign: "center", padding: "18px" }}>
              <div className="muted" style={{ fontSize: 12 }}>Your code</div>
              <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: ".12em", fontFamily: "ui-monospace, monospace" }}>{waCode}</div>
            </div>

            <div className="row center mt16" style={{ gap: 8 }}>
              <div className="spinner" style={{ width: 16, height: 16 }} />
              <span className="muted" style={{ fontSize: 13 }}>Waiting…</span>
            </div>

            <button className="btn ghost mt16" onClick={() => { setWaCode(null); setStep("hero"); }}>
              Back
            </button>
          </>
        )}

        {step === "passcode" && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>Enter your passcode</div>
            <div className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
              +91 {phone.slice(-10)}{" "}
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => { setStep("hero"); setPasscodeValue(""); }}>
                Change
              </span>
            </div>
            <div className="field">
              <label htmlFor="passcode-input">Passcode</label>
              <input
                id="passcode-input"
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
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => setStep("hero")}>
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
              <label htmlFor="otp-input">6-digit code</label>
              <input
                id="otp-input"
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
                <div style={{ color: "var(--amber)", fontSize: "13px", lineHeight: 1.5 }}>
                  +91 {phone.slice(-10)} isn't registered. Please visit your campus counter — staff will register you in
                  a moment, then you can sign in with just your number and a one-time code.
                </div>
              </div>
            </div>
            <button className="btn sec" onClick={() => { setStep("hero"); setNotRegistered(false); setOtp(""); }}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
