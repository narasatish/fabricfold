import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import SignOut from "../_components/SignOut";
import StaffAdminClient from "./_components/AdminClient";

export default async function StaffAdminPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");
  if (staff.role < 3) redirect("/s");

  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const month = istDate.slice(0, 7);
  const [cfg, colleges, staffList, payslips, plans, attToday, attMonth] = await Promise.all([
    db.appConfig.findUniqueOrThrow({ where: { id: "main" } }),
    db.college.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.staff.findMany({ orderBy: { role: "desc" } }),
    db.payslip.findMany({ include: { staff: true }, orderBy: { at: "desc" }, take: 12 }),
    db.plan.findMany({ orderBy: [{ collegeId: "asc" }, { price: "asc" }] }),
    db.attendance.findMany({ where: { date: istDate } }),
    db.attendance.groupBy({ by: ["staffId"], where: { date: { startsWith: month } }, _count: true }),
  ]);

  const slotWindows = await db.slotWindow.findMany({
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
        colleges={colleges.map((c) => ({ id: c.id, name: c.name, address: c.address, features: c.features as Record<string, boolean> }))}
        staff={staffList.map((x) => ({ id: x.id, name: x.name, phone: x.phone, role: x.role, collegeId: x.collegeId }))}
        plans={plans.map((p) => ({ id: p.id, collegeId: p.collegeId, name: p.name, price: N(p.price), gstFree: p.gstFree, active: p.active, buckets: p.buckets as { service: string; cycles: number; kgPerCycle: number }[] }))}
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
        payslips={payslips.map((p) => ({ id: p.id, number: p.number, month: p.month, net: N(p.net), staffName: p.staff.name }))}
        errors={recentErrors.map((e) => ({ id: e.id, kind: e.kind, message: e.message, url: e.url, seen: e.seen, at: e.at.getTime() }))}
        slotWindows={slotWindows.map((w) => ({ id: w.id, collegeId: w.collegeId, weekday: w.weekday, startMin: w.startMin, endMin: w.endMin, capacity: w.capacity, active: w.active }))}
        currentRole={staff.role}
      />
    </div>
  );
}
