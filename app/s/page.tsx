import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffHomeClient from "./_components/HomeClient";
import SignOut from "./_components/SignOut";

export default async function StaffHomePage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const N = (x: unknown) => Number(x || 0);

  const orders = await db.order.findMany({
    where: { status: { in: ["draft", "received", "processing", "ready"] } },
    include: { student: true },
    orderBy: { createdAt: "desc" },
  });

  // Pending subscription requests (active=false) + their cash OTP codes
  const pending = await db.subscription.findMany({ where: { active: false }, include: { student: true } });
  const pendingSubs = await Promise.all(
    pending.map(async (p) => {
      const otp = await db.otp.findFirst({ where: { purpose: "subscription", refId: p.studentId, usedAt: null } });
      return { studentId: p.studentId, student: { id: p.student.id, name: p.student.name }, hasOtp: !!otp };
    }),
  );

  const students = await db.student.findMany({ select: { id: true, name: true, phone: true } });
  const colleges = await db.college.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });

  // Attendance state for THIS staff member (IST business day)
  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const att = await db.attendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: istDate } } });
  const attendance = { clockedIn: !!att, clockedOut: !!att?.clockOut, since: att?.clockIn.getTime() ?? null };

  // At-a-glance dashboard metrics
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [todayPays, activeSubs, newStudents] = await Promise.all([
    db.payment.findMany({ where: { at: { gte: startOfDay }, amount: { gt: 0 }, method: { in: ["cash", "upi", "credit"] } }, select: { amount: true } }),
    db.subscription.count({ where: { active: true } }),
    db.student.count({ where: { createdAt: { gte: startOfDay } } }),
  ]);
  const metrics = {
    todayRevenue: todayPays.reduce((s, p) => s + N(p.amount), 0),
    pending: orders.filter((o) => o.status === "received" || o.status === "processing").length,
    ready: orders.filter((o) => o.status === "ready").length,
    activeSubs,
    newStudents,
  };

  const plainOrders = orders.map((o) => ({
    id: o.id,
    studentId: o.studentId,
    status: o.status,
    express: o.express,
    actualPieces: o.actualPieces,
    declaredPieces: o.declaredPieces,
    weightKg: o.weightKg == null ? null : N(o.weightKg),
    total: N(o.total),
    paid: o.paid,
    createdAt: o.createdAt.getTime(),
    receivedAt: o.receivedAt ? o.receivedAt.getTime() : null,
    dropSlotAt: o.dropSlotAt ? o.dropSlotAt.getTime() : null,
    student: { id: o.student.id, name: o.student.name, phone: o.student.phone },
  }));

  return (
    <div className="screen">
      <TopBar title="Counter" sub={`Welcome, ${staff.name.split(" ")[0]}`} right={<SignOut />} />
      <StaffHomeClient
        staff={{ name: staff.name, role: staff.role }}
        orders={plainOrders}
        pendingSubs={pendingSubs}
        students={students}
        colleges={colleges}
        metrics={metrics}
        attendance={attendance}
      />
    </div>
  );
}
