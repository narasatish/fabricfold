"use server";
/* Drop-off slots: students book a window to bring laundry in, so the counter
   queue stays spread. Windows are per-college weekly templates (Admin+ edits
   them); capacity caps how many orders may land in one window. */
import { db } from "../db";
import { requireStaff, requireStudent, assertSameCollege } from "../auth";
import { audit } from "../notify";
import { buildSlots, type Win } from "../slots";
import { BOOK_AHEAD_DAYS } from "../slot-capacity";

/* ---------- Customer: what can I book? ---------- */
export async function listDropSlots() {
  const stu = await requireStudent();
  const windows = await db.slotWindow.findMany({
    where: { collegeId: stu.collegeId, active: true },
    orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
  });
  if (!windows.length) return [];

  const now = new Date();
  const candidates = buildSlots(windows as unknown as Win[], BOOK_AHEAD_DAYS, now);
  if (!candidates.length) return [];

  // One grouped count for the whole range instead of a query per slot.
  const booked = await db.order.groupBy({
    by: ["dropSlotAt"],
    where: {
      collegeId: stu.collegeId,
      status: { in: ["draft", "received"] },
      dropSlotAt: { gte: candidates[0].startAt, lte: candidates[candidates.length - 1].startAt },
    },
    _count: { _all: true },
  });
  const takenAt = new Map(booked.map((b) => [b.dropSlotAt ? +b.dropSlotAt : 0, b._count._all]));

  return candidates.map((c) => {
    const taken = takenAt.get(+c.startAt) ?? 0;
    return {
      startAt: c.startAt.toISOString(),
      endAt: c.endAt.toISOString(),
      dateStr: c.dateStr,
      timeLabel: c.timeLabel,
      left: Math.max(0, c.capacity - taken),
      full: taken >= c.capacity,
    };
  });
}

/* ---------- Admin: manage the weekly windows ---------- */
export async function saveSlotWindow(input: {
  id?: string; collegeId: string; weekday: number; startMin: number; endMin: number; capacity: number;
}) {
  const st = await requireStaff(3);
  const { id, collegeId, weekday, startMin, endMin, capacity } = input;
  assertSameCollege(st, collegeId);

  if (weekday < 0 || weekday > 6) return { ok: false as const, error: "Pick a day" };
  if (startMin < 0 || endMin > 24 * 60) return { ok: false as const, error: "Times must be within the day" };
  if (endMin <= startMin) return { ok: false as const, error: "End time must be after the start time" };
  if (capacity < 1 || capacity > 500) return { ok: false as const, error: "Capacity must be 1–500" };

  if (id) {
    const existing = await db.slotWindow.findUniqueOrThrow({ where: { id } });
    assertSameCollege(st, existing.collegeId);
  }
  const data = { collegeId, weekday, startMin, endMin, capacity };
  const row = id
    ? await db.slotWindow.update({ where: { id }, data })
    : await db.slotWindow.create({ data });
  await audit(id ? "Slot window updated" : "Slot window added", `${weekday} ${startMin}-${endMin} cap ${capacity}`, st.id);
  return { ok: true as const, id: row.id };
}

export async function toggleSlotWindow(id: string) {
  const st = await requireStaff(3);
  const w = await db.slotWindow.findUniqueOrThrow({ where: { id } });
  assertSameCollege(st, w.collegeId);
  await db.slotWindow.update({ where: { id }, data: { active: !w.active } });
  await audit("Slot window " + (w.active ? "disabled" : "enabled"), id, st.id);
  return { ok: true as const, active: !w.active };
}

export async function deleteSlotWindow(id: string) {
  const st = await requireStaff(3);
  const w = await db.slotWindow.findUniqueOrThrow({ where: { id } });
  assertSameCollege(st, w.collegeId);
  await db.slotWindow.delete({ where: { id } });
  await audit("Slot window deleted", id, st.id);
  return { ok: true as const };
}
