/* Drop-off slot maths.

   Windows are stored per college as (weekday, startMin, endMin) in IST — never
   as absolute times — so they repeat weekly and survive DST-free IST cleanly.
   This module turns those templates into concrete UTC instants a student can
   book. Kept pure (no db, no I/O) so the timezone logic is unit-testable. */

export const IST_OFFSET_MS = 5.5 * 3600_000;

/** IST calendar date ("YYYY-MM-DD") for a UTC instant. */
export function istDateStr(at: Date | number) {
  return new Date(+at + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST weekday (0=Sun .. 6=Sat) for a UTC instant. */
export function istWeekday(at: Date | number) {
  return new Date(+at + IST_OFFSET_MS).getUTCDay();
}

/** Minutes-from-IST-midnight for a UTC instant (inverse of istInstant's time part). */
export function istMinutes(at: Date | number) {
  const d = new Date(+at + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** The UTC instant for an IST calendar date + minutes-from-midnight IST. */
export function istInstant(dateStr: string, minutes: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60_000 - IST_OFFSET_MS);
}

/** 540 -> "9am", 630 -> "10:30am", 1080 -> "6pm" */
export function hhmm(minutes: number) {
  const h = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  const ap = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${ap}`;
}

/** "Today" / "Tomorrow" / "Sat 19 Jul" for an IST date string, relative to now. */
export function dayLabel(dateStr: string, now: Date | number = new Date()) {
  const today = istDateStr(now);
  const tomorrow = istDateStr(+now + 86_400_000);
  if (dateStr === today) return "Today";
  if (dateStr === tomorrow) return "Tomorrow";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

export type Win = { id: string; weekday: number; startMin: number; endMin: number; capacity: number; active: boolean };
export type Candidate = {
  windowId: string;
  startAt: Date;
  endAt: Date;
  capacity: number;
  dateStr: string;
  timeLabel: string;
};

/** Concrete bookable drop-off slots over the next `days` IST days (today first).
    A window whose start time has already passed is never offered. */
export function buildSlots(windows: Win[], days: number, now: Date | number = new Date()): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < days; i++) {
    const dayInstant = +now + i * 86_400_000;
    const dateStr = istDateStr(dayInstant);
    const wd = istWeekday(dayInstant);
    for (const w of windows) {
      if (!w.active || w.weekday !== wd) continue;
      const startAt = istInstant(dateStr, w.startMin);
      if (+startAt <= +now) continue; // window already started — not bookable
      out.push({
        windowId: w.id,
        startAt,
        endAt: istInstant(dateStr, w.endMin),
        capacity: w.capacity,
        dateStr,
        timeLabel: `${hhmm(w.startMin)}–${hhmm(w.endMin)}`,
      });
    }
  }
  return out.sort((a, b) => +a.startAt - +b.startAt);
}
