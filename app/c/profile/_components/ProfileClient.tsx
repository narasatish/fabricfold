"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast, Sheet, Switch, toggleTheme } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { logout, updateName, setPasscode, changePasscode, signOutEverywhere } from "@/lib/actions/auth";
import { exportMyData, eraseMyData } from "@/lib/actions/privacy";

export default function ProfileClient({ studentName, hasPasscode }: { studentName: string; hasPasscode: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [showEditName, setShowEditName] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [editName, setEditName] = useState(studentName);
  const [loading, setLoading] = useState(false);

  /* Passcode: create if none, change if there is one. Changing demands the
     current one, so an unattended unlocked phone can't be turned into a
     permanent takeover. Forgetting it is never a dead end — OTP still signs
     you in, and you can set a new one here afterwards. */
  const [showPasscode, setShowPasscode] = useState(false);
  const [pcCurrent, setPcCurrent] = useState("");
  const [pcNew, setPcNew] = useState("");
  const [pcConfirm, setPcConfirm] = useState("");
  const [pcBusy, setPcBusy] = useState(false);

  const closePasscode = () => {
    setShowPasscode(false);
    setPcCurrent(""); setPcNew(""); setPcConfirm("");
  };

  const savePasscode = async () => {
    if (pcNew !== pcConfirm) return toast("The two passcodes don't match", true);
    setPcBusy(true);
    try {
      const r = hasPasscode ? await changePasscode(pcCurrent, pcNew) : await setPasscode(pcNew);
      if (!r.ok) return toast(r.error || "Failed", true);
      toast(hasPasscode ? "Passcode changed" : "Passcode created — you can now sign in with it");
      closePasscode();
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setPcBusy(false);
    }
  };
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  const handleSaveName = async () => {
    setLoading(true);
    try {
      const r = await updateName(editName);
      if (!r.ok) {
        toast(r.error || "Failed", true);
        return;
      }
      setShowEditName(false);
      toast("Name updated");
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setLoading(false);
    }
  };

  const handleDark = () => {
    toggleTheme();
    setDark((d) => !d);
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await logout();
    } catch {
      // The cookie may already be half-cleared server-side even if this
      // throws — leaving the user stuck on a "logged in" screen that no
      // longer has a valid session is worse than sending them to /login.
    } finally {
      router.push("/login");
    }
  };

  /* Found 2026-09-11: exportMyData, eraseMyData and signOutEverywhere all
     existed as fully-tested server actions (the staff-facing erase button
     was wired the same night this was found) but had no UI anywhere in the
     customer app — a student had no way to download their data, sign out
     a lost phone remotely, or erase their own account without visiting the
     counter. */
  const [exportBusy, setExportBusy] = useState(false);
  const handleExport = async () => {
    setExportBusy(true);
    try {
      const data = await exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fabricfold-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Download started");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setExportBusy(false);
    }
  };

  const [signOutAllBusy, setSignOutAllBusy] = useState(false);
  const handleSignOutEverywhere = async () => {
    if (!confirm("Sign out on every device signed in as you? You'll need to sign in again here too.")) return;
    setSignOutAllBusy(true);
    try {
      await signOutEverywhere();
    } catch {
      // Same reasoning as handleLogout — the cookie may already be cleared
      // even if this throws, so send them to /login regardless.
    } finally {
      router.push("/login");
    }
  };

  const [showErase, setShowErase] = useState(false);
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [eraseBusy, setEraseBusy] = useState(false);
  const handleErase = async () => {
    setEraseBusy(true);
    try {
      const r = await eraseMyData(eraseConfirm);
      if (!r.ok) return toast(r.error || "Failed", true);
      router.push("/login");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setEraseBusy(false);
    }
  };

  return (
    <>
      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", padding: "15px 18px" }}
        onClick={() => { setEditName(studentName); setShowEditName(true); }}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="edit" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Edit name</div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", padding: "15px 18px" }}
        onClick={() => setShowPasscode(true)}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="shield" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">{hasPasscode ? "Change passcode" : "Create a passcode"}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {hasPasscode ? "Sign in without waiting for an OTP" : "Skip the OTP wait next time you sign in"}
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", padding: "15px 18px" }}
        onClick={() => setShowTerms(true)}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="shield" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Terms, policies & compensation</div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <div className="list-item">
        <span style={{ color: "var(--teal)" }}>
          <Svg name="settings" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Dark mode</div>
          <div className="muted" style={{ fontSize: "12px" }}>Easier on the eyes at night</div>
        </div>
        <Switch on={dark} onToggle={handleDark} />
      </div>

      <button className="list-item tap" style={{ width: "100%", textAlign: "left", padding: "15px 18px" }} onClick={handleExport} disabled={exportBusy}>
        <span style={{ color: "var(--teal)" }}>
          <Svg name="list" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">{exportBusy ? "Preparing…" : "Download my data"}</div>
          <div className="muted" style={{ fontSize: 12 }}>Everything FabricFold holds about you, as a file</div>
        </div>
      </button>

      <button className="list-item tap" style={{ width: "100%", textAlign: "left", padding: "15px 18px" }} onClick={handleSignOutEverywhere} disabled={signOutAllBusy}>
        <span style={{ color: "var(--teal)" }}>
          <Svg name="shield" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">{signOutAllBusy ? "Signing out…" : "Sign out everywhere"}</div>
          <div className="muted" style={{ fontSize: 12 }}>Lost your phone? End every signed-in session, including this one</div>
        </div>
      </button>

      <button className="list-item tap" style={{ width: "100%", textAlign: "left", padding: "15px 18px", color: "var(--red)" }} onClick={handleLogout} disabled={loading}>
        <Svg name="logout" size={20} />
        <div style={{ flex: 1 }}>
          <div className="h-sm" style={{ color: "var(--red)" }}>{loading ? "Logging out…" : "Log out"}</div>
        </div>
      </button>

      <button className="list-item tap" style={{ width: "100%", textAlign: "left", padding: "15px 18px", color: "var(--red)" }} onClick={() => setShowErase(true)}>
        <Svg name="trash" size={20} />
        <div style={{ flex: 1 }}>
          <div className="h-sm" style={{ color: "var(--red)" }}>Erase my account</div>
          <div className="muted" style={{ fontSize: 12 }}>Permanent — removes your name and number, blocked while an order is in progress</div>
        </div>
      </button>

      {/* Create / change passcode */}
      <Sheet open={showPasscode} onClose={closePasscode}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>{hasPasscode ? "Change passcode" : "Create a passcode"}</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            A passcode lets you sign in without waiting for a text — handy where the signal is
            poor. You can always sign in with an OTP instead if you forget it.
          </div>

          {hasPasscode && (
            <div className="field">
              <label>Current passcode</label>
              <input className="input" type="password" value={pcCurrent} onChange={(e) => setPcCurrent(e.target.value)} />
            </div>
          )}
          <div className="field">
            <label>New passcode</label>
            <input className="input" type="password" placeholder="At least 4 characters" value={pcNew} onChange={(e) => setPcNew(e.target.value)} />
          </div>
          <div className="field">
            <label>Confirm new passcode</label>
            <input
              className="input"
              type="password"
              value={pcConfirm}
              onChange={(e) => setPcConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && pcNew && pcConfirm && !pcBusy) savePasscode(); }}
            />
          </div>
          {pcConfirm && pcNew !== pcConfirm && (
            <div className="muted" style={{ fontSize: 12, color: "var(--red)", marginBottom: 10 }}>
              The two passcodes don&apos;t match
            </div>
          )}

          <button
            className="btn"
            onClick={savePasscode}
            disabled={pcBusy || !pcNew || !pcConfirm || (hasPasscode && !pcCurrent)}
          >
            <Svg name="check" size={18} /> {pcBusy ? "Saving…" : hasPasscode ? "Change passcode" : "Create passcode"}
          </button>
        </div>
      </Sheet>

      {/* Edit name sheet */}
      <Sheet open={showEditName} onClose={() => setShowEditName(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Edit name</h2>
          <div className="field">
            <label>Your name</label>
            <input className="input" type="text" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <button className="btn mt16" onClick={handleSaveName} disabled={loading}>
            {loading ? "Saving…" : "Save"}
          </button>
        </div>
      </Sheet>

      {/* Terms sheet */}
      <Sheet open={showTerms} onClose={() => setShowTerms(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "12px" }}>Terms & policies</h2>
          <div className="card pad">
            <div className="h-sm">Service & turnaround</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Standard orders are ready in 2 days; express in 1 day (₹100 surcharge). You'll get a pickup code when your order is ready.</p>
            <div className="divider" />
            <div className="h-sm">Compensation policy</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Damaged, stained or missing garments are compensated as store credits (or cash at the manager's discretion) after counter verification. Free re-dos for unsatisfactory cleaning.</p>
            <div className="divider" />
            <div className="h-sm">Payments & refunds</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Pay by UPI, cash at the counter, or store credits. Refunds are returned the way you paid or as credits, with a GST credit note where an invoice was issued.</p>
          </div>
          <button className="btn sec mt16" onClick={() => setShowTerms(false)}>Close</button>
        </div>
      </Sheet>

      {/* Erase account */}
      <Sheet open={showErase} onClose={() => { setShowErase(false); setEraseConfirm(""); }}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px", color: "var(--red)" }}>Erase your account?</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            This cannot be undone. Your name and phone number are scrubbed and you won&apos;t be able to
            sign in again with this number. Orders and payments stay on record for accounting, shown as
            &quot;Deleted student&quot;. Blocked while you have an order in progress.
          </div>
          <div className="field">
            <label>Type DELETE to confirm</label>
            <input className="input" value={eraseConfirm} onChange={(e) => setEraseConfirm(e.target.value)} />
          </div>
          <button
            className="btn"
            style={{ background: "var(--red)" }}
            onClick={handleErase}
            disabled={eraseBusy || eraseConfirm.trim().toUpperCase() !== "DELETE"}
          >
            {eraseBusy ? "Erasing…" : "Erase my account permanently"}
          </button>
        </div>
      </Sheet>
    </>
  );
}
