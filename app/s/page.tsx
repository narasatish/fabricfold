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
    // the ready EVENT, not createdAt, is what ages an uncollected bag — an
    // order can spend days in processing before it ever waits on a student
    include: { student: true, timeline: { where: { status: "ready" }, orderBy: { at: "desc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
  });

  // Pending subscription requests (active=false) + their cash OTP codes
  const pending = await db.subscription.findMany({ where: { active: false }, include: { student: true } });
  /* One query for every pending code, not one per row. This was a findFirst
     inside a Promise.all — invisible with three pending, a queue of round
     trips with thirty. */
  const pendingOtps = pending.length
    ? await db.otp.findMany({
        where: { purpose: "subscription", usedAt: null, refId: { in: pending.map((p) => p.studentId) } },
        select: { refId: true },
      })
    : [];
  const withOtp = new Set(pendingOtps.map((o) => o.refId));
  const pendingSubs = pending.map((p) => ({
    studentId: p.studentId,
    student: { id: p.student.id, name: p.student.name },
    hasOtp: withOtp.has(p.studentId),
  }));

  /* The whole student table used to be fetched here and shipped to the
     browser so the browser could filter it and show ten matches — on every
     render, and this screen refreshes every 10 seconds. Search now runs on
     the server (searchStudents), which also means it finds students the old
     first-page fetch would have missed. */
  const colleges = await db.college.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });

  // Attendance state for THIS staff member (IST business day)
  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const att = await db.attendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: istDate } } });
  const attendance = { clockedIn: !!att, clockedOut: !!att?.clockOut, since: att?.clockIn.getTime() ?? null };

  /* Open complaints where the STUDENT has the last word — either no reply
     yet, or the student wrote again after staff last answered. A complaint
     staff already replied to (last message from "staff") is not waiting on
     anyone here; it's waiting on the student or on resolution. */
  const openComplaintsRaw = await db.complaint.findMany({
    where: { status: "open" },
    include: { student: { select: { name: true } }, messages: { orderBy: { at: "desc" }, take: 1 } },
    orderBy: { at: "desc" },
  });
  const openComplaints = openComplaintsRaw
    .filter((c) => !c.messages[0] || c.messages[0].from === "student")
    .map((c) => ({ id: c.id, studentId: c.studentId, studentName: c.student.name, at: (c.messages[0]?.at ?? c.at).getTime() }));

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
    readyAt: o.timeline[0] ? o.timeline[0].at.getTime() : null,
    student: { id: o.student.id, name: o.student.name, phone: o.student.phone },
  }));

  return (
    <div className="screen">
      <TopBar title="Counter" sub={`Welcome, ${staff.name.split(" ")[0]}`} right={<SignOut />} />
      <StaffHomeClient
        staff={{ name: staff.name, role: staff.role }}
        orders={plainOrders}
        pendingSubs={pendingSubs}
        colleges={colleges}
        metrics={metrics}
        attendance={attendance}
        openComplaints={openComplaints}
      />
    </div>
  );
}
