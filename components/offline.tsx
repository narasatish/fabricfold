"use client";
/* Offline state at the counter.

   The failure this addresses is not a crash — it is ambiguity. When the
   connection drops, a server action just hangs and then errors, and the staff
   member cannot tell whether the order went through. They ask the student to
   wait, tap again, and end up with two orders or none. Saying "you are
   offline" plainly, and showing exactly what is waiting to be sent, is most of
   the fix. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { listQueued, replayQueue, type QueuedIntake } from "@/lib/offline-queue";
import { walkInOrder } from "@/lib/actions/orders";
import { useToast } from "@/components/chrome";

/** navigator.onLine, kept current. */
export function useOnline() {
  /* Starts true on purpose. During SSR and the first client render there is no
     navigator, and defaulting to "offline" would flash a scary banner at every
     staff member on every page load. A wrong "online" corrects itself within a
     tick; a wrong "offline" erodes trust in the banner. */
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    addEventListener("online", sync);
    addEventListener("offline", sync);
    return () => {
      removeEventListener("online", sync);
      removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  const router = useRouter();
  const toast = useToast();
  const [queued, setQueued] = useState<QueuedIntake[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setQueued(listQueued()), []);

  useEffect(() => {
    refresh();
    /* Storage events fire only in OTHER tabs, so a counter with the order
       screen in one tab and the queue in another stays consistent. The interval
       covers this tab, where enqueueing does not raise an event. */
    addEventListener("storage", refresh);
    const t = setInterval(refresh, 4000);
    return () => {
      removeEventListener("storage", refresh);
      clearInterval(t);
    };
  }, [refresh]);

  const send = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const r = await replayQueue((row) =>
      walkInOrder(row.studentId, {
        service: row.service,
        items: row.items,
        weightKg: row.weightKg,
        useCycle: row.useCycle,
        noGst: row.noGst,
        express: row.express,
        idemKey: row.idemKey, // a repeat is rejected server-side, so retrying is safe
      }),
    );
    setBusy(false);
    refresh();
    if (r.sent) {
      toast(`${r.sent} queued order${r.sent === 1 ? "" : "s"} sent`);
      router.refresh();
    }
    if (r.failed) toast(r.firstError || "Could not send yet — still queued", true);
  }, [busy, refresh, router, toast]);

  // Send automatically the moment the connection returns.
  useEffect(() => {
    if (online && queued.length && !busy) void send();
    // deliberately keyed on `online` and the queue length only — re-running on
    // every render of `send` would retry in a loop while offline
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, queued.length]);

  if (online && !queued.length) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "sticky", top: 0, zIndex: 60,
        background: online ? "var(--amber-tint, #fff5e0)" : "var(--red-tint, #ffe9e9)",
        borderBottom: "1px solid rgba(0,0,0,.08)",
        padding: "8px 14px", fontSize: 13,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}
    >
      <strong style={{ color: online ? "var(--amber-dark, #8a5a00)" : "var(--red, #b00020)" }}>
        {online ? "Sending queued orders" : "No connection"}
      </strong>
      <span className="muted">
        {online
          ? `${queued.length} order${queued.length === 1 ? "" : "s"} waiting to reach the server.`
          : `Orders are being saved on this device${queued.length ? ` — ${queued.length} waiting` : ""}. They will send themselves when the connection returns.`}
      </span>
      {online && queued.length > 0 && (
        <button className="btn xs sec" onClick={send} disabled={busy} style={{ marginLeft: "auto" }}>
          {busy ? "Sending…" : "Send now"}
        </button>
      )}
    </div>
  );
}
