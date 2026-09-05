import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import SignOut from "../_components/SignOut";
import StaffAdminClient from "./_components/AdminClient";

export default async function StaffAdminPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const gate = await db.staff.findUnique({ where: { id: s.staffId }, select: { role: true } });
  // Admin+ only: this page carries payment config and staff phone numbers.
  // Client-side section-hiding was never a wall.
  if (!gate || gate.role < 3) redirect("/s");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");
  if (staff.role < 3) redirect("/s");

  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const month = istDate.slice(0, 7);
  // A campus-scoped Admin (role 3 with a collegeId set — "can only create/edit
  // staff ON their own campus", per saveStaff) was still shown every OTHER
  // campus's staff directory, payslips (net pay), plans, and attendance here
  // — the write side was already correctly guarded (assertSameCollege), only
  // the read side leaked. Owner (collegeId null) is unaffected.
  const staffScope = staff.collegeId ? { collegeId: staff.collegeId } : {};
  const [cfg, colleges, staffList, payslips, plans, attToday, attMonth] = await Promise.all([
    db.appConfig.findUniqueOrThrow({ where: { id: "main" } }),
    /* ALL colleges, not just active ones, for an OWNER — filtering here is
       what made "remove campus" a one-way door: the removed campus vanished
       from the only screen that could bring it back. A campus-scoped Admin
       has no business seeing (or reviving) a DIFFERENT campus either way. */
    db.college.findMany({
      where: staff.collegeId ? { id: staff.collegeId } : {},
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    db.staff.findMany({ where: staffScope, orderBy: { role: "desc" } }),
    db.payslip.findMany({ where: staff.collegeId ? { staff: staffScope } : {}, include: { staff: true }, orderBy: { at: "desc" }, take: 12 }),
    db.plan.findMany({ where: staffScope, orderBy: [{ collegeId: "asc" }, { price: "asc" }] }),
    db.attendance.findMany({ where: { date: istDate, ...(staff.collegeId ? { staff: staffScope } : {}) } }),
    db.attendance.groupBy({ by: ["staffId"], where: { date: { startsWith: month }, ...(staff.collegeId ? { staff: staffScope } : {}) }, _count: true }),
  ]);

  const slotWindows = await db.slotWindow.findMany({
    where: staffScope,
    orderBy: [{ collegeId: "asc" }, { weekday: "asc" }, { startMin: "asc" }],
  });

  const recentErrors = staff.role >= 4
    ? await db.errorLog.findMany({ orderBy: { at: "desc" }, take: 15 })
    : [];

  const N = (x: unknown) => Number(x || 0);
  return (
    <div className="screen">
      <TopBar title="Admin" sub={staff.role >= 4 ? "Owner" : "Admin"} right={<SignOut />} />
      <StaffAdminClient
        config={{
          gstPct: N(cfg.gstPct),
          plan: cfg.plan as { price: number; cycles: number; kgPerCycle: number },
          rates: cfg.rates as Record<string, { label: string; items: [string, number][] }>,
          payment: cfg.payment as { upiId: string; payeeName: string; bankName: string; accountName: string; accountNo: string; ifsc: string; gatewayKey: string },
          settings: cfg.settings as { reportEmail?: string; dailyEmail?: boolean; sendHour?: number; openingFloat?: number; garmentTagsEnabled?: boolean },
        }}
        colleges={colleges.map((c) => ({ id: c.id, name: c.name, address: c.address, closedWeekday: c.closedWeekday, active: c.active, features: c.features as Record<string, boolean>, rates: (c.rates as Record<string, { label: string; items: [string, number][] }> | null) || undefined }))}
        staff={staffList.map((x) => ({ id: x.id, name: x.name, phone: x.phone, role: x.role, collegeId: x.collegeId, active: x.active, perms: (x.perms as Record<string, boolean> | null) ?? {} }))}
        plans={plans.map((p) => ({ id: p.id, collegeId: p.collegeId, name: p.name, price: N(p.price), gstFree: p.gstFree, tier: p.tier, active: p.active, buckets: p.buckets as { service: string; cycles: number; kgPerCycle: number }[] }))}
        attendance={staffList.map((x) => {
          const today = attToday.find((a) => a.staffId === x.id);
          return {
            staffId: x.id, name: x.name,
            todayIn: today ? today.clockIn.getTime() : null,
            todayOut: today?.clockOut ? today.clockOut.getTime() : null,
            daysThisMonth: attMonth.find((a) => a.staffId === x.id)?._count ?? 0,
          };
        })}
        month={month}
        payslips={payslips.map((p) => ({ id: p.id, number: p.number, month: p.month, net: N(p.net), staffName: p.staff.name, collegeId: p.staff.collegeId }))}
        errors={recentErrors.map((e) => ({ id: e.id, kind: e.kind, message: e.message, url: e.url, seen: e.seen, at: e.at.getTime() }))}
        slotWindows={slotWindows.map((w) => ({ id: w.id, collegeId: w.collegeId, weekday: w.weekday, startMin: w.startMin, endMin: w.endMin, capacity: w.capacity, active: w.active }))}
        currentRole={staff.role}
      />
    </div>
  );
}
