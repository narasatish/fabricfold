"use client";
/* Login screen — phone + OTP entry, customer/staff mode toggle.
   No self-registration: a student account can only be created by staff at
   the counter (see lib/actions/admin.ts registerStudent). An unrecognised
   customer number gets a clear message instead of a signup form. */
import { useState } from "react";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { requestOtp, verifyOtp } from "@/lib/actions/auth";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);

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
            <div className="card pad center" style={{ background: "linear-gradient(135deg,var(--teal),var(--teal-dark))", color: "#fff", border: "none", marginBottom: "20px" }}>
              <div style={{ fontSize: "12px", opacity: 0.85, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
                Campus laundry & dry-cleaning
              </div>
              <div style={{ fontSize: "24px", fontWeight: 700, marginTop: "8px" }}>FabricFold</div>
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
                onKeyDown={(e) => { if (e.key === "Enter" && phone.length === 10 && !loading) handleRequestOtp(); }}
                inputMode="numeric"
              />
            </div>
            <button className="btn" onClick={handleRequestOtp} disabled={loading || phone.length !== 10}>
              {loading ? "Sending…" : "Send OTP"}
            </button>

            {mode === "customer" && (
              <div className="muted center mt16" style={{ fontSize: "12.5px", lineHeight: 1.5 }}>
                New here? Visit your campus counter to get registered — you'll then sign in with just your number.
              </div>
            )}
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
