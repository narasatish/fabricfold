"use client";
/* Staff sign-out. Ends the session and returns to /login. Without this the
   staff app has no way out — the session persists forever and every visit to
   /s drops straight into the (Owner) console, which is a problem on a shared
   counter device. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { useToast } from "@/components/chrome";
import { logout } from "@/lib/actions/auth";
import { clearOfflineCaches } from "@/lib/client-cache";

export default function SignOut() {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const signOut = async () => {
    if (!confirm("Sign out of the staff app?")) return;
    setLoading(true);
    try {
      await logout();
      await clearOfflineCaches();
      toast("Signed out");
      router.push("/login");
    } catch {
      // The cookie may already be half-cleared server-side even if this
      // throws — leaving the user stuck on a "logged in" screen that no
      // longer has a valid session is worse than sending them to /login.
      router.push("/login");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={signOut}
      disabled={loading}
      aria-label="Sign out"
      className="action wide"
      style={{ color: "var(--red)" }}
    >
      <Svg name="logout" size={19} />
      <span style={{ fontSize: 13, fontWeight: 600 }}>{loading ? "…" : "Sign out"}</span>
    </button>
  );
}
