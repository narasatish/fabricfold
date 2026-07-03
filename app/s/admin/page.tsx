import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffAdminClient from "./_components/AdminClient";

export default async function StaffAdminPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");
  if (staff.role < 3) redirect("/s");

  const [cfg, colleges, staffList, payslips] = await Promise.all([
    db.appConfig.findUniqueOrThrow({ where: { id: "main" } }),
    db.college.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    db.staff.findMany({ orderBy: { role: "desc" } }),
    db.payslip.findMany({ include: { staff: true }, orderBy: { at: "desc" }, take: 12 }),
  ]);

  const N = (x: unknown) => Number(x || 0);
  return (
    <div className="screen">
      <TopBar title="Admin" sub={staff.role >= 4 ? "Owner" : "Admin"} />
      <StaffAdminClient
        config={{
          gstPct: N(cfg.gstPct),
          plan: cfg.plan as { price: number; cycles: number; kgPerCycle: number },
          rates: cfg.rates as Record<string, { label: string; items: [string, number][] }>,
          payment: cfg.payment as { upiId: string; payeeName: string; bankName: string; accountName: string; accountNo: string; ifsc: string; gatewayKey: string },
          settings: cfg.settings as { reportEmail?: string; dailyEmail?: boolean; sendHour?: number; openingFloat?: number },
        }}
        colleges={colleges.map((c) => ({ id: c.id, name: c.name, address: c.address, features: c.features as Record<string, boolean> }))}
        staff={staffList.map((x) => ({ id: x.id, name: x.name, phone: x.phone, role: x.role, collegeId: x.collegeId }))}
        payslips={payslips.map((p) => ({ id: p.id, number: p.number, month: p.month, net: N(p.net), staffName: p.staff.name }))}
        currentRole={staff.role}
      />
    </div>
  );
}
