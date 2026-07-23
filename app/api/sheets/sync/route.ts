/* Google Sheets live sync — business figures only, NEVER student PII.

   Called by Vercel Cron every 10 minutes (and by the Owner on demand).
   Writes four tabs: Live, Daily, Plans, Staff.

   Auth: Bearer CRON_SECRET (cron), or an Owner session (manual refresh). */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { computeReport, parsePeriod } from "@/lib/report";
import { writeSheet, sheetsConfigured } from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const N = (x: unknown) => Number(x || 0);
const money = (n: number) => Math.round(n * 100) / 100;

/** IST business date — the server may run in any timezone. */
function istDate(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function authorised(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 4; // Owner only
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });
  if (!sheetsConfigured()) {
    return Response.json({ ok: false, error: "Google Sheets not configured — set GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GOOGLE_SHEET_ID" }, { status: 503 });
  }

  const stamp = new Date(Date.now() + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16) + " IST";
  const results: Record<string, unknown> = {};

  try {
    /* ---- Tab 1: Live — today at a glance ---- */
    const today = await computeReport(parsePeriod({ p: "day" }));
    const month = await computeReport(parsePeriod({ p: "month" }));
    const [activeOrders, readyOrders, activePlans, openComplaints] = await Promise.all([
      db.order.count({ where: { status: { in: ["received", "processing"] } } }),
      db.order.count({ where: { status: "ready" } }),
      db.subscription.count({ where: { active: true } }),
      db.complaint.count({ where: { status: "open" } }),
    ]);

    results.Live = await writeSheet("Live", [
      ["FabricFold — Live", `updated ${stamp}`],
      [],
      ["TODAY", ""],
      ["Orders received", today.ordersIn],
      ["Orders completed", today.ordersDone],
      ["Cash taken", money(today.cash)],
      ["UPI taken", money(today.upi)],
      ["Credit used", money(today.credit)],
      ["Total collected", money(today.total)],
      ["Refunds", money(today.refunds)],
      ["Expenses", money(today.expTotal)],
      ["Net", money(today.net)],
      ["Expected cash in drawer", money(today.expectedDrawer)],
      [],
      ["RIGHT NOW", ""],
      ["Orders in progress", activeOrders],
      ["Ready to collect", readyOrders],
      ["Active plans", activePlans],
      ["Open complaints", openComplaints],
      [],
      ["THIS MONTH", ""],
      ["Orders", month.ordersIn],
      ["Collected", money(month.total)],
      ["GST collected (net)", money(month.netGst)],
      ["Expenses", money(month.expTotal)],
      ["Net", money(month.net)],
      ["Avg turnaround (hrs)", Math.round(month.avgTurnaround * 10) / 10],
      ["Avg rating", Math.round(month.avgRating * 10) / 10],
    ]);

    /* ---- Tab 2: Daily — last 30 days, one row per day ---- */
    const daily: (string | number)[][] = [[
      "Date", "Orders in", "Completed", "Cash", "UPI", "Credit",
      "Collected", "Refunds", "Expenses", "Net", "GST (net)",
    ]];
    for (let i = 0; i < 30; i++) {
      const d = istDate(i);
      const r = await computeReport(parsePeriod({ p: "day", d }));
      // skip empty days at the tail so the sheet stays readable
      if (r.ordersIn === 0 && r.total === 0 && i > 6) continue;
      daily.push([
        d, r.ordersIn, r.ordersDone, money(r.cash), money(r.upi), money(r.credit),
        money(r.total), money(r.refunds), money(r.expTotal), money(r.net), money(r.netGst),
      ]);
    }
    results.Daily = await writeSheet("Daily", daily);

    /* ---- Tab 3: Plans — subscription sales per college ---- */
    const [colleges, plans] = await Promise.all([
      db.college.findMany({ select: { id: true, name: true } }),
      db.plan.findMany({ select: { id: true, name: true, price: true, collegeId: true, active: true } }),
    ]);
    const colName = (id: string) => colleges.find((c) => c.id === id)?.name || id;
    const planRows: (string | number)[][] = [["College", "Plan", "Price", "Active", "Subscribers", "Cycles used"]];
    for (const p of plans) {
      const subs = await db.subscription.findMany({
        where: { planId: p.id },
        select: { active: true, cyclesUsed: true },
      });
      planRows.push([
        colName(p.collegeId), p.name, N(p.price), p.active ? "yes" : "no",
        subs.filter((s) => s.active).length,
        subs.reduce((s, x) => s + x.cyclesUsed, 0),
      ]);
    }
    results.Plans = await writeSheet("Plans", planRows);

    /* ---- Tab 4: Staff — attendance + day-close (fraud watch) ---- */
    const m = istDate().slice(0, 7);
    const staff = await db.staff.findMany({ select: { id: true, name: true, role: true } });
    const ROLE: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
    const staffRows: (string | number)[][] = [["Staff", "Role", "Days present this month", "Last clock-in"]];
    for (const s of staff) {
      const att = await db.attendance.findMany({
        where: { staffId: s.id, date: { startsWith: m } },
        orderBy: { date: "desc" },
        select: { date: true, clockIn: true },
      });
      staffRows.push([s.name, ROLE[s.role] || String(s.role), att.length, att[0]?.date || "—"]);
    }
    staffRows.push([], ["DAY CLOSE — cash counted vs expected"], ["Date", "Expected", "Counted", "Variance", "Note"]);
    const closes = await db.dayClose.findMany({ orderBy: { date: "desc" }, take: 30 });
    for (const c of closes) {
      staffRows.push([c.date, money(N(c.expectedCash)), money(N(c.countedCash)), money(N(c.variance)), c.note || ""]);
    }
    results.Staff = await writeSheet("Staff", staffRows);

    return Response.json({ ok: true, at: stamp, results });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("sheets sync failed:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
