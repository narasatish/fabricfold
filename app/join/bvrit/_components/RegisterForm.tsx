"use client";
/* BVRIT self-registration via WhatsApp (Oct 2026), extended (Sep 2026) into
   the campus QR entry point: the same URL is now also where a RETURNING
   BVRIT customer signs back in, and where BVRIT staff (Counter/Manager) sign
   in — a physical QR sticker can't branch between "new" and "returning" or
   "customer" and "staff", so this one page has to handle all three.

   Students provide their name on this page, then send a WhatsApp message to
   prove phone ownership. The webhook verifies the phone, and the claim
   completes the account creation and mints a session.

   Returning-customer and staff sign-in reuse startWhatsAppLogin/
   checkWhatsAppLogin UNCHANGED — the exact mechanism /login already uses —
   rather than teaching the registration action a second job. Both are
   campus-agnostic by design (no collegeId parameter at all), which is
   exactly right here: an Admin/Owner signing in from this page must see
   BOTH campuses, the same as if they'd used /login, and duplicating that
   scoping logic here would only be a second place for it to drift. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { startWhatsAppRegister, checkWhatsAppRegister } from "@/lib/actions/wa-register";
import { startWhatsAppLogin, checkWhatsAppLogin } from "@/lib/actions/wa-login";
import InstallHint from "@/components/install-hint";

interface RegisterFormProps {
  collegeId: string;
  collegeName: string;
}

export default function RegisterForm({ collegeId, collegeName }: RegisterFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"form" | "whatsapp">("form");
  const [personMode, setPersonMode] = useState<"customer" | "staff">("customer");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [waCode, setWaCode] = useState<string | null>(null);
  // Set once registration reports "already registered" — the retry after
  // that point is a SIGN-IN attempt, not another registration attempt, and
  // the poll below needs to know which result shape to expect back.
  const [signingIn, setSigningIn] = useState(false);
  const waTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Poll while a WhatsApp registration is outstanding. Same pattern as login. */
  useEffect(() => {
    if (!waCode) return;
    const stop = () => { if (waTimer.current) clearInterval(waTimer.current); waTimer.current = null; };
    waTimer.current = setInterval(async () => {
      if (signingIn) {
        const r = await checkWhatsAppLogin(waCode);
        if (r.ok && r.status === "pending") return;
        stop();
        setWaCode(null);
        if (r.ok && r.status === "signed-in") { toast("Signed in"); router.push("staff" in r && r.staff ? "/s" : "/c"); return; }
        if (!r.ok) { setStep("form"); setSigningIn(false); toast(r.error, true); }
        return;
      }
      const r = await checkWhatsAppRegister(waCode);
      if (r.ok && r.status === "pending") return;         // still waiting
      stop();
      setWaCode(null);
      if (r.ok && r.status === "registered") { toast("Welcome to FabricFold!"); router.push("/c"); return; }
      if (!r.ok) {
        setStep("form");
        toast(r.error, true);
        // The webhook's own message for this case ends in "sign in instead" —
        // matched loosely so a future copy tweak there doesn't silently break
        // this fallback.
        if (/sign in instead/i.test(r.error)) setShowSignInOffer(true);
      }
    }, 2000);
    return stop;
  }, [waCode, signingIn, router, toast]);

  const [showSignInOffer, setShowSignInOffer] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (name.trim().length < 2) {
      toast("Enter your name", true);
      return;
    }

    setLoading(true);
    setShowSignInOffer(false);
    try {
      const r = await startWhatsAppRegister({ name, collegeId });

      if (!r.ok) { toast(r.error, true); return; }

      /* Open WhatsApp BEFORE starting the poll, same as login. */
      window.open(r.link, "_blank", "noopener");
      setWaCode(r.code);
      setSigningIn(false);
      setStep("whatsapp");
    } catch (e) {
      toast((e as Error).message || "Failed to start registration", true);
    } finally {
      setLoading(false);
    }
  };

  /* A returning customer, or staff — reuses /login's own mechanism, not a
     copy of it. mode "staff" is reachable via the corner toggle below. */
  const handleWhatsAppSignIn = async (mode: "customer" | "staff") => {
    setLoading(true);
    try {
      const r = await startWhatsAppLogin(mode);
      if (!r.ok) { toast(r.error, true); return; }
      window.open(r.link, "_blank", "noopener");
      setWaCode(r.code);
      setSigningIn(true);
      setStep("whatsapp");
    } catch (e) {
      toast((e as Error).message || "Failed to start sign-in", true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="screen no-nav">
      <div className="topbar">
        <h1>FabricFold</h1>
        {/* Same quiet corner exit as /login — staff at this campus sign in
            from this exact URL too, so the QR sticker never needs to
            distinguish who is scanning it. */}
        {step === "form" && (
          <button
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-2)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 4px" }}
            onClick={() => { setPersonMode(personMode === "staff" ? "customer" : "staff"); setShowSignInOffer(false); }}
          >
            {personMode === "staff" ? "← Customer" : "Staff sign-in"}
          </button>
        )}
      </div>

      <div className="pad" style={{ paddingTop: "24px" }}>
        {step === "form" && (
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

            {personMode === "staff" ? (
              <>
                <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{collegeName} staff sign-in</h2>
                <p className="muted" style={{ fontSize: "14.5px", marginBottom: 20, lineHeight: 1.4 }}>
                  Registered staff numbers only — ask the owner if yours isn&apos;t working.
                </p>
                <button className="btn" onClick={() => handleWhatsAppSignIn("staff")} disabled={loading} style={{ fontSize: 17, height: 54 }}>
                  {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Join {collegeName}</h2>
                <p className="muted" style={{ fontSize: "14.5px", marginBottom: 20, lineHeight: 1.4 }}>
                  Start using FabricFold right away. Pay per wash, track your laundry, get pickup alerts on WhatsApp.
                </p>

                {showSignInOffer && (
                  <div className="card pad" style={{ background: "var(--teal-tint, #eaf6f2)", borderColor: "var(--teal-soft, #bfe3d8)", marginBottom: 16 }}>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 }}>
                      This number is already registered.
                    </div>
                    <button className="btn sec" onClick={() => handleWhatsAppSignIn("customer")} disabled={loading} style={{ width: "100%" }}>
                      {loading ? "Opening WhatsApp…" : "Sign in instead"}
                    </button>
                  </div>
                )}

                <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div>
                    <label htmlFor="name-input" style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--ink-1)" }}>Your name</label>
                    <input
                      id="name-input"
                      type="text"
                      placeholder="Enter your full name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={loading}
                      autoFocus
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: "8px",
                        border: "1px solid var(--border)",
                        fontSize: 16,
                        fontFamily: "inherit",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>

                  <button className="btn" type="submit" disabled={loading} style={{ fontSize: 17, height: 54 }}>
                    {loading ? "Opening WhatsApp…" : "Continue with WhatsApp"}
                  </button>
                </form>

                <div className="muted center mt8" style={{ fontSize: "12.5px" }}>
                  New here? Sends a WhatsApp message to register. Already registered? Same button — we&apos;ll sign you in.
                </div>
              </>
            )}

            <InstallHint />
          </>
        )}

        {step === "whatsapp" && (
          <>
            <div style={{ textAlign: "center", marginTop: "60px" }}>
              <div style={{ marginBottom: 24, color: "var(--success)" }}>
                <Svg name="check" size={48} />
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Waiting for verification…</h2>
              <p className="muted" style={{ fontSize: "14px" }}>
                Send the code <strong style={{ color: "var(--ink-1)", fontFamily: "monospace" }}>{waCode}</strong> in a WhatsApp message to our number.
              </p>
              <p className="muted" style={{ fontSize: "13px", marginTop: 16 }}>
                {signingIn ? "You'll be signed in automatically once we receive your message." : "You'll be registered automatically once we receive your message."}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
