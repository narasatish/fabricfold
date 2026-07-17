"use client";
/* Login screen — phone + OTP entry → customer/staff mode toggle → registration flow for new customers. */
import { useState } from "react";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { requestOtp, verifyOtp, listColleges } from "@/lib/actions/auth";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"phone" | "otp" | "register">("phone");
  const [mode, setMode] = useState<"customer" | "staff">("customer");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [colleges, setColleges] = useState<Array<{ id: string; name: string }>>([]);
  const [name, setName] = useState("");
  const [collegeId, setCollegeId] = useState("");

  const handleRequestOtp = async () => {
    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      toast("Enter a valid 10-digit number", true);
      return;
    }
    setLoading(true);
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
    const r = await verifyOtp(phone, otp, mode, mode === "customer" ? { name: name.trim(), collegeId } : undefined);
    setLoading(false);

    if (!r.ok) {
      if (r.error === "NEEDS_REGISTRATION") {
        setColleges(await listColleges());
        setStep("register");
        return;
      }
      toast(r.error, true);
      return;
    }
    toast("Signed in");
    router.push(mode === "customer" ? "/c" : "/s");
  };

  const handleRegisterAndVerify = async () => {
    if (!name.trim()) {
      toast("Enter your name", true);
      return;
    }
    if (!collegeId) {
      toast("Select your campus", true);
      return;
    }
    setLoading(true);
    const r = await verifyOtp(phone, otp, "customer", { name, collegeId });
    setLoading(false);
    if (!r.ok) {
      toast(r.error, true);
      return;
    }
    toast("Account created — welcome!");
    router.push("/c");
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
          </>
        )}

        {step === "otp" && (
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

        {step === "register" && (
          <>
            <div className="h-md" style={{ marginBottom: "8px" }}>
              Complete your profile
            </div>
            <div className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
              Just a couple more details
            </div>

            <div className="field">
              <label>Full name</label>
              <input className="input" type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="field">
              <label>Campus</label>
              <select
                className="input"
                value={collegeId}
                onChange={(e) => setCollegeId(e.target.value)}
              >
                <option value="">Select campus</option>
                {colleges.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <button className="btn" onClick={handleRegisterAndVerify} disabled={loading || !name.trim() || !collegeId}>
              {loading ? "Creating…" : "Get started"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
