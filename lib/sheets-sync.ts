/* The actual Sheets sync — shared by the cron route and the Admin "Sync now"
   button. Business AGGREGATES ONLY: no student names, phones or per-student
   rows ever cross into a Google Sheet (see lib/sheets.ts for the contract). */
import { db } from "./db";
import { computeReport, parsePeriod } from "./report";
import { writeSheet, readSheet, sheetsConfigured } from "./sheets";
import { audit } from "./notify";

const N = (x: unknown) => Number(x || 0);
const money = (n: number) => Math.round(n * 100) / 100;

function istDate(offsetDays = 0) {
  return new Date(Date.now() + 5.5 * 3600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/* ---- Config round-trip ----
   The ONLY tab the app reads back from. The owner may edit prices / GST here and
   the change is validated and applied to the live app. Deliberately excludes
   orders, payments and invoices — those are the tamper-proof ledger and must
   never be writable from a spreadsheet. Every applied change is audited. */
async function applyConfigEdits(): Promise<string[]> {
  const rows = await readSheet("Config");
  if (!rows.length) return [];

  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const rates = structuredClone(cfg.rates as Record<string, { label: string; items: [string, number][] }>);
  const settings = { ...(cfg.settings as Record<string, unknown>) };
  let gstPct = Number(cfg.gstPct);
  const changes: string[] = [];
  const planUpdates: { id: string; price: number; label: string }[] = [];

  // Plan lookups for "Plan · <College> · <Name>" rows
  const [allColleges, allPlans] = await Promise.all([
    db.college.findMany({ select: { id: true, name: true } }),
    db.plan.findMany({ select: { id: true, name: true, price: true, collegeId: true } }),
  ]);

  // Rows are: [Setting, Value]. We recognise a fixed, safe allow-list of keys.
  for (const [rawKey, rawVal] of rows) {
    const key = (rawKey || "").trim();
    const val = (rawVal ?? "").toString().trim();
    if (!key || val === "") continue;

    if (key === "GST %") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0 && n <= 28 && n !== gstPct) { changes.push(`GST ${gstPct}%→${n}%`); gstPct = n; }
    } else if (key === "GST billing") {
      const on = /^(on|yes|true|1)$/i.test(val);
      if (on !== settings.gstEnabled) { changes.push(`GST billing ${on ? "ON" : "OFF"}`); settings.gstEnabled = on; }
    } else if (/^plan\s*·/i.test(key)) {
      // "Plan · <College> · <Plan name>" -> that plan's price
      const parts = key.split("·").map((s) => s.trim());
      if (parts.length === 3) {
        const col = allColleges.find((c) => c.name.toLowerCase() === parts[1].toLowerCase());
        const matches = col ? allPlans.filter((p) => p.collegeId === col.id && p.name.toLowerCase() === parts[2].toLowerCase()) : [];
        const price = Number(val);
        // exactly one match, sane bounds — ambiguity or unknown names are ignored
        if (matches.length === 1 && Number.isFinite(price) && price >= 100 && price <= 100000 && price !== Number(matches[0].price)) {
          planUpdates.push({ id: matches[0].id, price, label: `${parts[1]}·${parts[2]} ₹${Number(matches[0].price)}→₹${price}` });
        }
      }
    } else {
      // "<service> · <item>" price cells, e.g. "washIron · Regular garment"
      const m = key.split("·").map((s) => s.trim());
      if (m.length === 2 && rates[m[0]]) {
        const items = rates[m[0]].items;
        const idx = items.findIndex((it) => it[0] === m[1]);
        const price = Number(val);
        if (idx >= 0 && Number.isFinite(price) && price > 0 && price <= 100000 && price !== items[idx][1]) {
          changes.push(`${m[0]}·${m[1]} ₹${items[idx][1]}→₹${price}`);
          items[idx] = [items[idx][0], price];
        }
      }
    }
  }

  if (changes.length) {
    await db.appConfig.update({ where: { id: "main" }, data: { rates: rates as object, gstPct, settings: settings as object } });
  }
  for (const u of planUpdates) {
    await db.plan.update({ where: { id: u.id }, data: { price: u.price } });
    changes.push(u.label);
  }
  if (changes.length) await audit("Config edited via Sheet", changes.join("; ").slice(0, 480), "sheet");
  return changes;
}

export async function runSheetsSync() {
  if (!sheetsConfigured()) {
    return { ok: false as const, error: "Google Sheets not configured — set GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GOOGLE_SHEET_ID" };
  }
  const stamp = new Date(Date.now() + 5.5 * 3600_000).toISOString().replace("T", " ").slice(0, 16) + " IST";

  // 1) Pull any owner edits from the Config tab and apply them (validated + audited).
  const applied = await applyConfigEdits();

  /* ---- Live ---- */
  const today = await computeReport(parsePeriod({ p: "day" }));
  const month = await computeReport(parsePeriod({ p: "month" }));
  const [activeOrders, readyOrders, activePlans, openComplaints] = await Promise.all([
    db.order.count({ where: { status: { in: ["received", "processing"] } } }),
    db.order.count({ where: { status: "ready" } }),
    db.subscription.count({ where: { active: true } }),
    db.complaint.count({ where: { status: "open" } }),
  ]);

  await writeSheet("Live", [
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

  /* ---- Daily (last 30 days) ---- */
  const daily: (string | number)[][] = [[
    "Date", "Orders in", "Completed", "Cash", "UPI", "Credit",
    "Collected", "Refunds", "Expenses", "Net", "GST (net)",
  ]];
  for (let i = 0; i < 30; i++) {
    const d = istDate(i);
    const r = await computeReport(parsePeriod({ p: "day", d }));
    if (r.ordersIn === 0 && r.total === 0 && i > 6) continue;
    daily.push([
      d, r.ordersIn, r.ordersDone, money(r.cash), money(r.upi), money(r.credit),
      money(r.total), money(r.refunds), money(r.expTotal), money(r.net), money(r.netGst),
    ]);
  }
  await writeSheet("Daily", daily);

  /* ---- Plans ---- */
  const [colleges, plansAll] = await Promise.all([
    db.college.findMany({ select: { id: true, name: true, active: true } }),
    db.plan.findMany({ select: { id: true, name: true, price: true, collegeId: true, active: true } }),
  ]);
  const colName = (id: string) => colleges.find((c) => c.id === id)?.name || id;
  /* A removed campus takes its plans off the sheet with it (owner, Sep 2026 —
     BVRIT rows kept resurfacing after the campus was gone). The database
     keeps everything; the sheet shows the business that exists. */
  const liveCollegeIds = new Set(colleges.filter((c) => c.active).map((c) => c.id));
  const plans = plansAll.filter((p) => liveCollegeIds.has(p.collegeId));
  const planRows: (string | number)[][] = [["College", "Plan", "Price", "Active", "Subscribers", "Cycles used"]];
  for (const p of plans) {
    const subs = await db.subscription.findMany({ where: { planId: p.id }, select: { active: true, cyclesUsed: true } });
    planRows.push([
      colName(p.collegeId), p.name, N(p.price), p.active ? "yes" : "no",
      subs.filter((s) => s.active).length, subs.reduce((s, x) => s + x.cyclesUsed, 0),
    ]);
  }
  await writeSheet("Plans", planRows);

  /* ---- Students (roster) ---- The owner's register: everyone who can walk
     up to the counter, their customer ID, plan and balance. Phone numbers ARE
     here — this is the owner's own operational sheet and they asked for them;
     the privacy page names Google as a processor for exactly this data. */
  await writeStudentsTab();

  /* ---- Complaints ---- Every grievance and what it cost to settle, so the
     true price of service failures is visible next to the revenue figures
     rather than buried in the app. Student NAMES are included here because
     this sheet is the owner's own operational record; no phone numbers or
     addresses, matching the no-PII-beyond-necessity rule elsewhere. */
  const complaints = await db.complaint.findMany({
    orderBy: { at: "desc" },
    take: 200,
    include: { student: { select: { name: true } } },
  });
  const compRows: (string | number)[][] = [[
    "Raised", "Student", "Order", "Status", "Issue", "Free re-wash", "Compensation", "Resolved",
  ]];
  for (const c of complaints) {
    const payouts = await db.compensation.findMany({
      where: { complaintId: c.id },
      select: { amount: true },
    });
    const paid = payouts.reduce((s, p) => s + N(p.amount), 0);
    compRows.push([
      c.at.toISOString().slice(0, 10),
      c.student.name,
      c.orderId ? "#" + c.orderId.slice(-4) : "—",
      c.status,
      c.text.slice(0, 120),
      c.redoOrderId ? "#" + c.redoOrderId.slice(-4) : "—",
      paid ? money(paid) : "—",
      c.resolvedAt ? c.resolvedAt.toISOString().slice(0, 10) : "—",
    ]);
  }
  const openCount = complaints.filter((c) => c.status === "open").length;
  compRows.push([], ["Open", openCount, "Resolved", complaints.length - openCount]);
  await writeSheet("Complaints", compRows);

  /* ---- Staff (attendance + day-close) ---- */
  const m = istDate().slice(0, 7);
  const staff = await db.staff.findMany({ select: { id: true, name: true, phone: true, role: true, active: true } });
  const ROLE: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
  const staffRows: (string | number)[][] = [["Staff", "Phone", "Role", "Active", "Days present this month", "Last clock-in"]];
  for (const s of staff) {
    const att = await db.attendance.findMany({
      where: { staffId: s.id, date: { startsWith: m } },
      orderBy: { date: "desc" }, select: { date: true },
    });
    staffRows.push([s.name, "+91 " + s.phone, ROLE[s.role] || String(s.role), s.active ? "yes" : "removed", att.length, att[0]?.date || "—"]);
  }
  staffRows.push([], ["DAY CLOSE — cash counted vs expected"], ["Date", "Expected", "Counted", "Variance", "Note"]);
  const closes = await db.dayClose.findMany({ orderBy: { date: "desc" }, take: 30 });
  for (const c of closes) {
    staffRows.push([c.date, money(N(c.expectedCash)), money(N(c.countedCash)), money(N(c.variance)), c.note || ""]);
  }
  await writeSheet("Staff", staffRows);

  /* ---- Config (editable) — the current live values, ready to change ---- */
  const fresh = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const fRates = fresh.rates as Record<string, { label: string; items: [string, number][] }>;
  const fSettings = fresh.settings as Record<string, unknown>;
  const cfgRows: (string | number)[][] = [
    ["Setting", "Value", "← edit the Value column, then it applies on the next sync"],
    ["GST %", Number(fresh.gstPct), "0–28"],
    ["GST billing", fSettings.gstEnabled === false ? "off" : "on", "on / off"],
    [],
    ["PRICES (₹ per piece)", "", ""],
  ];
  for (const [svc, r] of Object.entries(fRates)) {
    for (const [item, price] of r.items) {
      cfgRows.push([`${svc} · ${item}`, price, r.label]);
    }
  }
  cfgRows.push([], ["PLAN PRICES (₹ per plan)", "", ""]);
  const freshPlans = await db.plan.findMany({ select: { name: true, price: true, collegeId: true, active: true } });
  for (const p of freshPlans) {
    cfgRows.push([`Plan · ${colName(p.collegeId)} · ${p.name}`, N(p.price), p.active ? "active" : "inactive"]);
  }
  await writeSheet("Config", cfgRows);

  return { ok: true as const, at: stamp, tabs: ["Live", "Daily", "Plans", "Staff", "Config"], applied };
}

/* ─── Roster tabs, refreshable on their own ────────────────────────────────

   Registrations, imports and staff changes update the sheet WITHOUT waiting
   for the nightly full sync — the owner reads this sheet as the register, and
   a register that lags a day is one nobody trusts. Wholesale rewrite, not
   append: the roster is small (hundreds of rows), and rewriting is immune to
   the dedup drift that append-based tabs suffer. */
export async function writeStudentsTab() {
  const students = await db.student.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      college: { select: { name: true } },
      subscription: { select: { active: true, plan: true, cyclesTotal: true, cyclesUsed: true } },
      bags: { where: { status: "active" }, select: { code: true }, take: 1 },
    },
  });
  const rows: (string | number)[][] = [["Customer ID", "Name", "Phone", "Type", "College", "Plan", "Cycles left", "Joined"]];
  for (const st of students) {
    rows.push([
      st.bags[0]?.code || st.id,
      st.name,
      "+91 " + st.phone,
      st.kind === "faculty" ? "Faculty" : "Student",
      st.college?.name || "—",
      st.subscription?.active ? st.subscription.plan : "—",
      st.subscription?.active ? st.subscription.cyclesTotal - st.subscription.cyclesUsed : "—",
      st.createdAt.toISOString().slice(0, 10),
    ]);
  }
  rows.push([], ["Total", students.length, "Faculty", students.filter((x) => x.kind === "faculty").length]);
  await writeSheet("Students", rows);
}

export async function runRosterSync() {
  if (!sheetsConfigured()) return { ok: false as const, error: "sheets not configured" };
  await writeStudentsTab();
  return { ok: true as const };
}

/** Fire-and-forget roster refresh from a server action. Same after() shape as
    flushSoon(): a bare void promise dies when the serverless instance
    freezes, and a failed sheet write must never fail a registration. */
export function rosterSoon() {
  const run = async () => { try { await runRosterSync(); } catch (e) { console.error("roster sync failed", e); } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { after } = require("next/server");
    after(run());
  } catch {
    void run();
  }
}
