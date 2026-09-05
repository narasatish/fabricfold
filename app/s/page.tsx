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
  // Every query below used to run company-wide regardless of the signed-in
  // staff member's own campus, then rely on the CLIENT to filter what's
  // displayed — meaning the full cross-campus payload (names, phones,
  // complaint text, revenue) was already shipped to the browser for a
  // campus-scoped staff member, who should never see another campus's data
  // at all. `scope` below is the shared filter; Owner (collegeId null) still
  // sees everything, unchanged.
  const scope = staff.collegeId ? { collegeId: staff.collegeId } : {};

  const orders = await db.order.findMany({
    where: { status: { in: ["draft", "received", "processing", "ready"] }, ...scope },
    // the ready EVENT, not createdAt, is what ages an uncollected bag — an
    // order can spend days in processing before it ever waits on a student
    include: {
      // Only the fields this page actually renders — the full Student row
      // (credits, passwordHash/Salt, lifetimePieces, etc.) has no business
      // riding along on the highest-traffic staff screen, refreshed every 10s.
      student: { select: { id: true, name: true, phone: true, collegeId: true } },
      timeline: { where: { status: "ready" }, orderBy: { at: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  // Pending subscription requests (active=false) + their cash OTP codes
  const pending = await db.subscription.findMany({
    where: { active: false, ...(staff.collegeId ? { student: { collegeId: staff.collegeId } } : {}) },
    include: { student: { select: { id: true, name: true, collegeId: true } } },
  });
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
    student: { id: p.student.id, name: p.student.name, collegeId: p.student.collegeId },
    hasOtp: withOtp.has(p.studentId),
  }));

  /* The whole student table used to be fetched here and shipped to the
     browser so the browser could filter it and show ten matches — on every
     render, and this screen refreshes every 10 seconds. Search now runs on
     the server (searchStudents), which also means it finds students the old
     first-page fetch would have missed. */
  const colleges = await db.college.findMany({
    where: { active: true, ...(staff.collegeId ? { id: staff.collegeId } : {}) },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  // Attendance state for THIS staff member (IST business day)
  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const att = await db.attendance.findUnique({ where: { staffId_date: { staffId: staff.id, date: istDate } } });
  const attendance = { clockedIn: !!att, clockedOut: !!att?.clockOut, since: att?.clockIn.getTime() ?? null };

  /* Open complaints where the STUDENT has the last word — either no reply
     yet, or the student wrote again after staff last answered. A complaint
     staff already replied to (last message from "staff") is not waiting on
     anyone here; it's waiting on the student or on resolution. */
  const openComplaintsRaw = await db.complaint.findMany({
    where: { status: "open", ...scope },
    include: { student: { select: { name: true, collegeId: true } }, messages: { orderBy: { at: "desc" }, take: 1 } },
    orderBy: { at: "desc" },
  });
  const openComplaints = openComplaintsRaw
    .filter((c) => !c.messages[0] || c.messages[0].from === "student")
    .map((c) => ({ id: c.id, studentId: c.studentId, studentName: c.student.name, collegeId: c.student.collegeId, at: (c.messages[0]?.at ?? c.at).getTime() }));

  /* At-a-glance dashboard metrics — one campus at a time, switched instantly
     on the client rather than a server round-trip per tap. Cheap because the
     college count is small (a handful, not hundreds): grouping in memory
     beats N+1 queries, one per campus. */
  /* setHours(0,0,0,0) zeroes out the SERVER's local day, which is UTC on
     Render — near midnight IST that's the previous IST day, so "today's
     takings" would silently span the wrong 24 hours while `istDate` above
     (used for attendance on this same page) correctly says otherwise.
     `istDate` is already the IST calendar day; anchor the boundary to it. */
  const startOfDay = new Date(`${istDate}T00:00:00+05:30`);
  const [todayPays, activeSubsRows, newStudentsByCollege] = await Promise.all([
    db.payment.findMany({ where: { at: { gte: startOfDay }, amount: { gt: 0 }, method: { in: ["cash", "upi", "credit"] }, ...scope }, select: { amount: true, collegeId: true } }),
    db.subscription.findMany({ where: { active: true, ...(staff.collegeId ? { student: { collegeId: staff.collegeId } } : {}) }, select: { student: { select: { collegeId: true } } } }),
    // Still a COUNT, not a fetch — groupBy aggregates in the database, same
    // as db.student.count() did before campuses needed splitting apart.
    db.student.groupBy({ by: ["collegeId"], where: { createdAt: { gte: startOfDay }, ...scope }, _count: true }),
  ]);
  const newStudentsCount = (collegeId: string | null) =>
    newStudentsByCollege.filter((g) => !collegeId || g.collegeId === collegeId).reduce((s, g) => s + g._count, 0);
  const metricsFor = (collegeId: string | null) => ({
    todayRevenue: todayPays.filter((p) => !collegeId || p.collegeId === collegeId).reduce((s, p) => s + N(p.amount), 0),
    pending: orders.filter((o) => (o.status === "received" || o.status === "processing") && (!collegeId || o.student.collegeId === collegeId)).length,
    ready: orders.filter((o) => o.status === "ready" && (!collegeId || o.student.collegeId === collegeId)).length,
    activeSubs: activeSubsRows.filter((s) => !collegeId || s.student.collegeId === collegeId).length,
    newStudents: newStudentsCount(collegeId),
  });
  const metrics: Record<string, ReturnType<typeof metricsFor>> = { all: metricsFor(null) };
  for (const c of colleges) metrics[c.id] = metricsFor(c.id);

  const plainOrders = orders.map((o) => ({
    id: o.id,
    studentId: o.studentId,
    collegeId: o.student.collegeId,
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
