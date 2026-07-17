/* Drop-off slot maths — pure timezone logic, no DB. The whole point of these
   tests is that IST (UTC+5:30) offsets are easy to get subtly wrong and fail
   silently (a student books "9am Sat" and staff see 3:30am Sat). */
import { describe, expect, it } from "vitest";
import { buildSlots, hhmm, istDateStr, istInstant, istMinutes, istWeekday, dayLabel, type Win } from "../lib/slots";

// 2026-07-17T04:00:00Z === Fri 17 Jul 2026, 09:30 IST
const NOW = new Date("2026-07-17T04:00:00.000Z");
const FRI = 5, SAT = 6;

const win = (o: Partial<Win> & { weekday: number; startMin: number; endMin: number }): Win => ({
  id: `w-${o.weekday}-${o.startMin}`, capacity: 15, active: true, ...o,
});

describe("IST conversions", () => {
  it("late-evening UTC already belongs to the next IST day", () => {
    // 19:00Z = 00:30 IST the following day — the classic off-by-one-day trap
    expect(istDateStr(new Date("2026-07-17T19:00:00Z"))).toBe("2026-07-18");
    expect(istWeekday(new Date("2026-07-17T19:00:00Z"))).toBe(SAT);
    // ...while the same UTC day earlier on is still Friday in IST
    expect(istDateStr(NOW)).toBe("2026-07-17");
    expect(istWeekday(NOW)).toBe(FRI);
  });

  it("istInstant maps an IST wall-clock time to the right UTC instant", () => {
    // 09:00 IST on 17 Jul === 03:30Z
    expect(istInstant("2026-07-17", 540).toISOString()).toBe("2026-07-17T03:30:00.000Z");
    // midnight IST === 18:30Z the previous day
    expect(istInstant("2026-07-17", 0).toISOString()).toBe("2026-07-16T18:30:00.000Z");
  });

  it("istInstant round-trips through istDateStr", () => {
    expect(istDateStr(istInstant("2026-07-18", 540))).toBe("2026-07-18");
    expect(istDateStr(istInstant("2026-07-18", 0))).toBe("2026-07-18");
  });

  it("istMinutes inverts istInstant's time-of-day", () => {
    expect(istMinutes(istInstant("2026-07-18", 540))).toBe(540);
    expect(istMinutes(istInstant("2026-07-18", 0))).toBe(0);
    expect(istMinutes(istInstant("2026-07-18", 1439))).toBe(1439);
    // a stored 4pm-IST slot reads back as 4pm, not 10:30am (the raw UTC time)
    expect(hhmm(istMinutes(new Date("2026-07-17T10:30:00Z")))).toBe("4pm");
  });
});

describe("time formatting", () => {
  it("renders 12-hour labels the way a student reads them", () => {
    expect(hhmm(540)).toBe("9am");
    expect(hhmm(630)).toBe("10:30am");
    expect(hhmm(720)).toBe("12pm"); // noon, not 0pm
    expect(hhmm(0)).toBe("12am");   // midnight, not 0am
    expect(hhmm(1080)).toBe("6pm");
  });

  it("labels today and tomorrow relatively", () => {
    expect(dayLabel("2026-07-17", NOW)).toBe("Today");
    expect(dayLabel("2026-07-18", NOW)).toBe("Tomorrow");
    expect(dayLabel("2026-07-19", NOW)).toContain("19 Jul");
  });
});

describe("buildSlots", () => {
  it("never offers a window that has already started", () => {
    // Fri 9–11am starts 03:30Z, which is before NOW (04:00Z)
    const past = [win({ weekday: FRI, startMin: 540, endMin: 660 })];
    expect(buildSlots(past, 1, NOW)).toEqual([]);
  });

  it("offers a later window on the same day", () => {
    const later = [win({ weekday: FRI, startMin: 960, endMin: 1080 })]; // 4–6pm
    const out = buildSlots(later, 1, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].startAt.toISOString()).toBe("2026-07-17T10:30:00.000Z"); // 4pm IST
    expect(out[0].timeLabel).toBe("4pm–6pm");
    expect(out[0].dateStr).toBe("2026-07-17");
  });

  it("only matches windows on their own weekday, and looks ahead N days", () => {
    const windows = [
      win({ weekday: SAT, startMin: 540, endMin: 660 }), // Sat 9–11am
      win({ weekday: FRI, startMin: 960, endMin: 1080 }), // Fri 4–6pm
    ];
    // 1 day of lookahead = today (Fri) only → Saturday must not appear
    expect(buildSlots(windows, 1, NOW).map((s) => s.dateStr)).toEqual(["2026-07-17"]);
    // 2 days → Friday evening then Saturday morning, in chronological order
    expect(buildSlots(windows, 2, NOW).map((s) => s.dateStr)).toEqual(["2026-07-17", "2026-07-18"]);
  });

  it("skips inactive windows", () => {
    const windows = [win({ weekday: FRI, startMin: 960, endMin: 1080, active: false })];
    expect(buildSlots(windows, 3, NOW)).toEqual([]);
  });

  it("returns slots sorted chronologically regardless of input order", () => {
    const windows = [
      win({ weekday: SAT, startMin: 540, endMin: 660 }),
      win({ weekday: FRI, startMin: 1200, endMin: 1320 }),
      win({ weekday: FRI, startMin: 960, endMin: 1080 }),
    ];
    const out = buildSlots(windows, 3, NOW);
    const times = out.map((s) => +s.startAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(out[0].timeLabel).toBe("4pm–6pm");
  });

  it("carries capacity through from the window", () => {
    const out = buildSlots([win({ weekday: FRI, startMin: 960, endMin: 1080, capacity: 3 })], 1, NOW);
    expect(out[0].capacity).toBe(3);
  });
});
