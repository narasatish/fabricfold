"use client";
/* Shared chrome: TopBar, TabBar, Sheet, Toast, Seg, Switch — classnames map 1:1
   onto the prototype's CSS (see globals.css). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Svg } from "./icons";

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string, isError?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function AppShell({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; err: boolean; show: boolean }>({ msg: "", err: false, show: false });
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string, isError = false) => {
    clearTimeout(t.current);
    setToast({ msg, err: isError, show: true });
    t.current = setTimeout(() => setToast((x) => ({ ...x, show: false })), 2400);
  }, []);
  useEffect(() => {
    const th = localStorage.getItem("ff_theme");
    if (th) document.documentElement.setAttribute("data-theme", th);
  }, []);
  return (
    <ToastCtx.Provider value={showToast}>
      <div id="app">{children}</div>
      <div id="toast" className={`${toast.show ? "show" : ""} ${toast.err ? "err" : ""}`}>{toast.msg}</div>
    </ToastCtx.Provider>
  );
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "" : "dark";
  if (next) document.documentElement.setAttribute("data-theme", next);
  else document.documentElement.removeAttribute("data-theme");
  localStorage.setItem("ff_theme", next);
}

/* ---------- TopBar ---------- */
export function TopBar({ title, sub, back, right }: { title: string; sub?: string; back?: string; right?: ReactNode }) {
  const router = useRouter();
  return (
    <div className="topbar">
      {back != null && (
        <button className="back" onClick={() => (back ? router.push(back) : router.back())} aria-label="Back">
          <Svg name="back" size={20} />
        </button>
      )}
      <div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="spacer" />
      {right}
    </div>
  );
}

/* ---------- TabBar ---------- */
export function TabBar({ tabs, active }: { tabs: { key: string; label: string; icon: string; href: string; badge?: number }[]; active: string }) {
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`tab ${active === t.key ? "active" : ""}`}>
          {t.badge ? <span className="badge">{t.badge}</span> : null}
          <Svg name={t.icon} />
          <span>{t.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* ---------- Bottom sheet ---------- */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const [render, setRender] = useState(open);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (open) {
      setRender(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)));
    } else {
      setShow(false);
      const id = setTimeout(() => setRender(false), 400);
      return () => clearTimeout(id);
    }
  }, [open]);
  // lock background scroll while a sheet is up
  useEffect(() => {
    if (!render) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [render]);
  if (!render) return null;
  return (
    <div className={`sheet-bg ${show ? "show" : ""}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="grab" />
        {children}
      </div>
    </div>
  );
}

/* ---------- Segmented control ---------- */
export function Seg<T extends string>({ options, value, onChange }: { options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([k, l]) => (
        <button key={k} className={value === k ? "active" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/* ---------- Switch ---------- */
export function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} onClick={onToggle} role="switch" aria-checked={on} />;
}

/* ---------- Realtime (SSE) ---------- */
export function useRealtime(onEvent: (ev: { type: string; payload: Record<string, unknown> }) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const es = new EventSource("/api/rt");
    es.onmessage = (m) => {
      try { cb.current(JSON.parse(m.data)); } catch { /* ignore */ }
    };
    return () => es.close();
  }, []);
}

/* ---------- Refresh-on-realtime helper ---------- */
export function RealtimeRefresh({ types, toastOn }: { types?: string[]; toastOn?: Record<string, string> }) {
  const router = useRouter();
  const toast = useToast();
  useRealtime((ev) => {
    if (!types || types.includes(ev.type)) {
      if (toastOn?.[ev.type]) toast(toastOn[ev.type]);
      router.refresh();
    }
  });
  return null;
}
