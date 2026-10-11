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
import { requestOtp, verifyOtp, hasPasscode, loginWithPasscode, createPasswordWithCustomerId } from "@/lib/actions/auth";
import { startWhatsAppLogin, checkWhatsAppLogin } from "@/lib/actions/wa-login";
import InstallHint from "@/components/install-hint";

export default function LoginForm() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"hero" | "otp" | "passcode" | "setpw" | "whatsapp">("hero");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [passcode, setPasscodeValue] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [newPw, setNewPw] = useState("");
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
    try {
      const r = await startWhatsAppLogin(mode);
      if (!r.ok) { toast(r.error, true); return; }
      /* Opened BEFORE we start polling, and in the same tick as the tap: a
         popup opened from an async callback is blocked on iOS Safari. */
      window.open(r.link, "_blank", "noopener");
      setWaCode(r.code);
      setStep("whatsapp");
    } catch (e) {
      toast((e as Error).message || "Failed to start login", true);
    } finally {
      setLoading(false);
    }
  };

  /* A student with a password goes straight to entering it. One with none
     yet goes to set one up with their customer ID (createPasswordWithCustomerId)
     instead — not to WhatsApp, which has been unreliable (owner, Oct 2026:
     slow or not arriving on some phones). WhatsApp stays as a fallback link
     below, not the primary door anymore. */
  const handleContinue = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    setLoading(true);
    try {
      const r = await hasPasscode(phone);
      setStep(r.hasPasscode ? "passcode" : "setpw");
    } catch (e) {
      toast((e as Error).message || "Failed to check account", true);
    } finally {
      setLoading(false);
    }
  };

  const handleSetPassword = async () => {
    if (!customerId.trim()) { toast("Enter your customer ID", true); return; }
    if (newPw.length < 4) { toast("Password must be at least 4 characters", true); return; }
    setLoading(true);
    try {
      const r = await createPasswordWithCustomerId(phone, customerId, newPw);
      if (!r.ok) { toast(r.error, true); return; }
      toast("Password set — signed in");
      router.push("/c");
    } catch (e) {
      toast((e as Error).message || "Failed to set password", true);
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

  /* Reachable ONLY from "forgot passcode" now — every other OTP door was
     removed from the UI because it depends on an SMS provider that isn't
     configured. This one stays because a locked-out student needs SOME
     path that isn't "message us on WhatsApp with your passcode problem". */
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
            onClick={() => setMode(mode === "staff" ? "customer" : "staff")}
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
                {/* Password is the primary door now: it works with no WhatsApp
                    dependency at all, for both signing in and (via "setpw")
                    setting one up the first time. */}
                <div className="field">
                  <label htmlFor="phone-input">Mobile number</label>
                  <input
                    id="phone-input"
                    className="input"
                    type="tel"
                    placeholder="10-digit number"
                    autoFocus
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(-10))}
                    onKeyDown={(e) => { if (e.key === "Enter" && phone.length === 10 && !loading) handleContinue(); }}
                    inputMode="numeric"
                  />
                </div>
                <button className="btn" onClick={handleContinue} disabled={loading || phone.length !== 10} style={{ fontSize: 17, height: 54 }}>
                  {loading ? "Checking…" : "Continue"}
                </button>
                <div className="muted center mt8" style={{ fontSize: "12.5px" }}>
                  No password yet? You&apos;ll set one up with your customer ID.
                </div>

                <div className="row center mt16" style={{ gap: 8 }}>
                  <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
                  <span className="muted" style={{ fontSize: 12 }}>or</span>
                  <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
                </div>
                <button className="btn sec mt16" onClick={handleWhatsApp} disabled={loading}>
                  {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                </button>

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

        {step === "setpw" && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>Set your password</div>
            <div className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
              +91 {phone.slice(-10)}{" "}
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => { setStep("hero"); setCustomerId(""); setNewPw(""); }}>
                Change
              </span>
            </div>
            <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
              Enter the customer ID printed on your bag — staff gave it to you at the counter — to prove it&apos;s you, no code needed.
            </div>
            <div className="field">
              <label htmlFor="customerid-input">Customer ID</label>
              <input
                id="customerid-input"
                className="input"
                type="text"
                placeholder="e.g. S1009"
                autoFocus
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value.toUpperCase().replace(/\s+/g, ""))}
              />
            </div>
            <div className="field mt12">
              <label htmlFor="newpw-input">New password</label>
              <input
                id="newpw-input"
                className="input"
                type="password"
                placeholder="At least 4 characters"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !loading) handleSetPassword(); }}
              />
            </div>
            <button className="btn mt12" onClick={handleSetPassword} disabled={loading || !customerId.trim() || newPw.length < 4}>
              {loading ? "Setting up…" : "Set password and sign in"}
            </button>
            <div className="muted center mt12" style={{ fontSize: "12px" }}>
              Don&apos;t have your customer ID? Visit the counter, or{" "}
              <span style={{ color: "var(--teal-dark)", fontWeight: 600, cursor: "pointer" }} onClick={() => { setStep("hero"); handleWhatsApp(); }}>
                try WhatsApp instead
              </span>.
            </div>
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
