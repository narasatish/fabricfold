"use client";
/* BVRIT self-registration via WhatsApp (Oct 2026).

   Students provide their name on this page, then send a WhatsApp message to
   prove phone ownership. The webhook verifies the phone, and the claim
   completes the account creation and mints a session. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { startWhatsAppRegister, checkWhatsAppRegister } from "@/lib/actions/wa-register";

interface RegisterFormProps {
  collegeId: string;
  collegeName: string;
}

export default function RegisterForm({ collegeId, collegeName }: RegisterFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"form" | "whatsapp">("form");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [waCode, setWaCode] = useState<string | null>(null);
  const waTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /* Poll while a WhatsApp registration is outstanding. Same pattern as login. */
  useEffect(() => {
    if (!waCode) return;
    const stop = () => { if (waTimer.current) clearInterval(waTimer.current); waTimer.current = null; };
    waTimer.current = setInterval(async () => {
      const r = await checkWhatsAppRegister(waCode, name);
      if (r.ok && r.status === "pending") return;         // still waiting
      stop();
      setWaCode(null);
      if (r.ok && r.status === "registered") { toast("Welcome to FabricFold!"); router.push("/c"); return; }
      if (!r.ok) { setStep("form"); toast(r.error, true); }
    }, 2000);
    return stop;
  }, [waCode, name, router, toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (name.trim().length < 2) {
      toast("Enter your name", true);
      return;
    }

    setLoading(true);
    const r = await startWhatsAppRegister({ name, collegeId });
    setLoading(false);

    if (!r.ok) { toast(r.error, true); return; }

    /* Open WhatsApp BEFORE starting the poll, same as login. */
    window.open(r.link, "_blank", "noopener");
    setWaCode(r.code);
    setStep("whatsapp");
  };

  return (
    <div className="screen no-nav">
      <div className="topbar">
        <h1>FabricFold</h1>
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

            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Join {collegeName}</h2>
            <p className="muted" style={{ fontSize: "14.5px", marginBottom: 20, lineHeight: 1.4 }}>
              Start using FabricFold right away. Pay per wash, track your laundry, get pickup alerts on WhatsApp.
            </p>

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6, color: "var(--ink-1)" }}>Your name</label>
                <input
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
              No code to wait for — send one message and you&apos;re registered.
            </div>
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
                You&apos;ll be registered automatically once we receive your message.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
