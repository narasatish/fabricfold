"use client";
/* Login screen (redesigned, Sep 2026, owner's call):

   WhatsApp is the ONE path shown by default — no phone field on first
   paint. Two reasons together, not one: OTP is fully broken for staff
   (no SMS provider configured) and for any first-time customer (no
   passcode exists yet to fall back to), so a bare phone+Continue button
   was a coin flip between "works" and "silently leads to a dead OTP
   screen". Offering it as the FIRST thing a visitor sees was the bug —
   the fix is showing the door that actually opens.

   The phone field still exists, for the one case it's genuinely needed:
   a returning student who set a passcode. It's one tap away behind
   "Have a passcode?", not the first thing on the page.

   Staff moves from a big segmented control to a small corner link — the
   owner's own estimate is that this door gets used "very less", and the
   UI now matches that: Customer is the hero, Staff is a quiet exit for
   the rare visitor who needs it.

   No self-registration: a student account can only be created by staff at
   the counter (see lib/actions/admin.ts registerStudent). An unrecognised
   customer number gets a clear message instead of a signup form. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { requestOtp, verifyOtp, hasPasscode, loginWithPasscode } from "@/lib/actions/auth";
import { startWhatsAppLogin, checkWhatsAppLogin } from "@/lib/actions/wa-login";
import InstallHint from "@/components/install-hint";

export default function LoginForm() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"hero" | "otp" | "passcode" | "whatsapp">("hero");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [showPhone, setShowPhone] = useState(false); // the passcode-entry door, collapsed by default
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
      if (!r.ok) { setStep("hero"); toast(r.error, true); }
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

  /* Students who have set a passcode go straight to it — no waiting for a
     text, and it works where the signal doesn't. A number with NO passcode
     is sent back to WhatsApp rather than into a guaranteed-dead OTP screen —
     that redirect is the whole point of this redesign. */
  const handleContinue = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    setLoading(true);
    const r = await hasPasscode(phone);
    setLoading(false);
    if (r.hasPasscode) { setStep("passcode"); return; }
    setShowPhone(false);
    toast("No passcode set for this number yet — tap Continue with WhatsApp", true);
  };

  const handlePasscodeLogin = async () => {
    setLoading(true);
    const r = await loginWithPasscode(phone, passcode);
    setLoading(false);
    if (!r.ok) { toast(r.error, true); return; }
    toast("Signed in");
    router.push("/c");
  };

  /* Reachable ONLY from "forgot passcode" now — every other OTP door was
     removed from the UI because it depends on an SMS provider that isn't
     configured. This one stays because a locked-out student needs SOME
     path that isn't "message us on WhatsApp with your passcode problem". */
  const handleRequestOtp = async () => {
    setLoading(true);
    setNotRegistered(false);
    const r = await requestOtp(phone, "customer");
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
    const r = await verifyOtp(phone, otp, "customer");
    setLoading(false);

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
  };

  return (
    <div className="screen no-nav">
      <div className="topbar">
        <h1>FabricFold</h1>
        {/* The corner exit the owner asked for: Staff is a small, quiet link,
            not a big control competing with the Customer flow for attention. */}
        {step === "hero" && (
          <button
            /* Deliberately no CSS class here: the topbar's own "spacer"
               utility is flex:1, meant for an empty filler div — put on a
               button with real text it would center that text in the
               leftover space instead of pushing it flush right.
               marginLeft:auto alone does the job. */
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
            {/* The logo carries its own wordmark, so it replaces the lettered
                gradient card rather than sitting on top of one. Width/height
                reserve the box before the image arrives — no layout jump —
                and the source is a 264px, ~37KB asset (was a 512px, ~104KB
                PNG) so this stays fast on a slow campus connection. */}
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

            {mode === "customer" ? (
              <>
                {/* THE hero action — everything else is a footnote beneath it. */}
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
                {/* Staff: WhatsApp only. The number must already be on the
                    admin-managed roster — checked server-side — so this is
                    the ONLY door, not a shortcut past a real one; the OTP
                    path it replaces cannot work without an SMS provider,
                    and showing it anyway was the original bug. */}
                <button className="btn" onClick={handleWhatsApp} disabled={loading} style={{ fontSize: 17, height: 54 }}>
                  {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                </button>
                <div className="muted center mt8" style={{ fontSize: "12.5px" }}>
                  Registered staff numbers only — ask the owner if yours isn&apos;t working.
                </div>
              </>
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
            <button className="btn sec" onClick={() => { setStep("hero"); setNotRegistered(false); setOtp(""); }}>
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
