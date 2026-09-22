"use client";
/* Shared chrome: TopBar, TabBar, Sheet, Toast, Seg, Switch — classnames map 1:1
   onto the prototype's CSS (see globals.css). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Svg, type IconName } from "./icons";

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
export function TabBar({ tabs, active }: { tabs: { key: string; label: string; icon: IconName; href: string; badge?: number }[]; active: string }) {
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
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  /* CSS `vh`/`dvh` are sized against the LAYOUT viewport, which iOS Safari
     does NOT shrink for the on-screen keyboard by default — so a sheet's
     `max-height:90vh` stays a fixed height even once the keyboard covers
     the bottom third of the screen, pushing the sheet's own submit button
     (walk-in order, compensation, register — every form lives in a Sheet)
     down behind the keyboard: visible in the DOM, unreachable to a tap.
     `window.visualViewport` tracks the actually-visible area including the
     keyboard on both iOS and Android, so cap the sheet to THAT instead
     whenever it's smaller than the CSS max-height would otherwise allow. */
  const [vvh, setVvh] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVvh(vv.height);
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
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
  // Move focus into the sheet on open (a keyboard/screen-reader user must land
  // somewhere inside it, not be left on whatever was behind it), and restore
  // focus to what opened it on close — the standard dialog contract.
  useEffect(() => {
    if (render) {
      restoreFocusTo.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
    } else {
      restoreFocusTo.current?.focus?.();
      restoreFocusTo.current = null;
    }
  }, [render]);
  // Escape closes it, same as a backdrop click — a keyboard user has no
  // pointer to click outside with.
  useEffect(() => {
    if (!render) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [render, onClose]);
  if (!render) return null;
  return (
    <div className={`sheet-bg ${show ? "show" : ""}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sheet"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        style={vvh ? { maxHeight: Math.round(vvh * 0.92) } : undefined}
      >
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

/* ---------- Campus switch ----------
   A staff member juggling multiple campuses (St Mary's, BVRIT, ...) needs to
   flip between them without re-navigating or hunting through a buried filter
   row — the owner's own complaint after seeing them mixed together on one
   screen. One shared hook + pill row, used the same way on every staff
   screen that's per-campus: Home, Students, and anywhere else that follows.
   Sticky in localStorage so the choice survives a page change or reload. */
const CAMPUS_KEY = "ff-staff-campus";
export function useCampusSwitch(colleges: { id: string; name: string }[]) {
  const [campus, setCampusState] = useState<string>("all");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CAMPUS_KEY);
      if (saved && (saved === "all" || colleges.some((c) => c.id === saved))) setCampusState(saved);
    } catch { /* private browsing / storage blocked — default "all" is fine */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setCampus = useCallback((v: string) => {
    setCampusState(v);
    try { localStorage.setItem(CAMPUS_KEY, v); } catch { /* not persisted this session, still works */ }
  }, []);
  return [campus, setCampus] as const;
}

export function CampusSwitch({ colleges, value, onChange }: { colleges: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  if (colleges.length < 2) return null; // nothing to switch between
  return (
    <div className="seg" style={{ margin: "0 16px 10px" }}>
      <button className={value === "all" ? "active" : ""} onClick={() => onChange("all")}>All</button>
      {colleges.map((c) => (
        <button key={c.id} className={value === c.id ? "active" : ""} onClick={() => onChange(c.id)}>{c.name}</button>
      ))}
    </div>
  );
}

/* ---------- Switch ---------- */
export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label?: string }) {
  /* A bare toggle has no text of its own, so a screen reader announces it as
     "switch" with no name. Take an explicit `label`; when a call site doesn't
     give one, name it from the text sitting beside it in the same row. */
  const ref = useRef<HTMLButtonElement>(null);
  const [auto, setAuto] = useState<string | undefined>();
  useEffect(() => {
    if (label) return;
    const p = ref.current?.parentElement;
    if (!p) return;
    const t = Array.from(p.childNodes).filter((n) => n !== ref.current).map((n) => (n instanceof HTMLElement ? n.innerText : n.textContent) ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
    if (t) setAuto(t);
  }, [label]);
  return <button ref={ref} type="button" className={`switch ${on ? "on" : ""}`} onClick={onToggle} role="switch" aria-checked={on} aria-label={label ?? auto} />;
}

/* ---------- Realtime (polling) ----------
   Vercel's serverless runtime can't push across instances, so we poll — but
   the app must stay SMOOTH. What actually makes it feel live is refreshing the
   instant the tab regains focus (returning to the app shows fresh data at
   once). Background polling is a gentle safety net, not the main mechanism, so
   it runs on a long interval — a laundry order doesn't change second-to-second,
   and frequent full re-renders were the biggest cause of jank. */
export function useRealtime(onTick: () => void, intervalMs = 20000) {
  const cb = useRef(onTick);
  cb.current = onTick;
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") cb.current(); };
    const id = setInterval(tick, intervalMs);
    const onFocus = () => tick();               // instant refresh when you come back
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [intervalMs]);
}

/* ---------- Refresh-on-realtime helper ----------
   `intervalMs` lets a busy screen (e.g. the staff order queue) poll faster.
   `types`/`toastOn` kept for call-site compatibility. */
export function RealtimeRefresh({ intervalMs }: { types?: string[]; toastOn?: Record<string, string>; intervalMs?: number } = {}) {
  const router = useRouter();
  useRealtime(() => router.refresh(), intervalMs);
  return null;
}
