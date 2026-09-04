import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { staffCan } from "@/lib/perms";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { parsePeriod, computeReport } from "@/lib/report";
import { fmt, timeAgo } from "@/lib/format";
import { Svg } from "@/components/icons";
import ReportsControls, { ExpenseButton, EmailReportButton, CloseDayButton } from "./_components/ReportsClient";

export default async function StaffReportsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  /* Money reports are a named tool, not a staff birthright: Counter staff
     see the queue, not the revenue. The owner grants exceptions per person. */
  const me = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!me || !staffCan(me, "reports")) redirect("/s");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const period = parsePeriod(sp);
  const r = await computeReport(period, staff.collegeId);
  const istDate = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const dayClose = await db.dayClose.findUnique({ where: { date: istDate } });
  const staffList = await db.staff.findMany(staff.collegeId ? { where: { collegeId: staff.collegeId } } : undefined);
  const byId = (id: string) => staffList.find((x) => x.id === id)?.name || id;
  const N = (x: unknown) => Number(x || 0);

  // analytics — 8-week revenue bars, repeat rate, subscriber split
  const now = Date.now();
  const weekMs = 7 * 86_400_000;
  const allPayments = await db.payment.findMany({ where: { at: { gte: new Date(now - 8 * weekMs) } } });
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const from = now - (8 - i) * weekMs, to = now - (7 - i) * weekMs;
    return allPayments.filter((p) => p.at.getTime() >= from && p.at.getTime() < to && N(p.amount) > 0).reduce((s2, p) => s2 + N(p.amount), 0);
  });
  const maxWeek = Math.max(1, ...weeks);
  /* Two numbers used to cost one row per ORDER EVER RECORDED.

     This page re-renders on a timer, so at 50,000 orders it was re-reading
     50,000 rows every few seconds to display a percentage and a total.
     groupBy returns one row per STUDENT instead (bounded by enrolment, not by
     history), and the revenue total comes back as a single aggregate. Same
     arithmetic, same answers — pinned by a test that runs both ways over the
     same data and compares.

     Prisma aggregates rather than raw SQL on purpose: the money suite still
     has a SQLite fallback, and `count(*) FILTER (...)` is Postgres-only. */
  const [perStudent, payAgg, activeSubs] = await Promise.all([
    db.order.groupBy({ by: ["studentId"], _count: { _all: true } }),
    db.order.aggregate({ _sum: { total: true }, where: { usedCycle: false, paid: true } }),
    db.subscription.count({ where: { active: true } }),
  ]);
  const repeatRate = perStudent.length
    ? Math.round((perStudent.filter((g) => g._count._all >= 2).length / perStudent.length) * 100)
    : 0;
  const payRevenue = N(payAgg._sum.total);
  const cfgRow = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const plan = cfgRow.plan as { price: number };
  const subRevenueApprox = activeSubs * plan.price;
  const cohortPct = subRevenueApprox + payRevenue > 0 ? Math.round((subRevenueApprox / (subRevenueApprox + payRevenue)) * 100) : 0;

  const qs = (over: Record<string, string>) => {
    const params = new URLSearchParams({ p: period.kind, ...(sp.d ? { d: sp.d } : {}), ...(sp.m ? { m: sp.m } : {}), ...(sp.y ? { y: sp.y } : {}), ...over });
    return params.toString();
  };

  const white = { color: "rgba(255,255,255,.75)" };

  return (
    <div className="screen">
      <TopBar title="Reports" sub={period.label} />
      {/* No refresher here on purpose: app/s/layout.tsx already mounts one for
          every staff screen. A second timer refreshed nothing sooner — it just
          re-ran this page's queries about three times per 20 seconds instead
          of two, and this is the page whose queries are the heaviest. */}
      <div className="pad">
        <ReportsControls period={period.kind} d={sp.d} m={sp.m} y={sp.y} />

        {/* Collections hero — fixed dark surface in BOTH themes */}
        <div className="card pad mt16" style={{ background: "#10201b", color: "#fff", border: "none" }}>
          <div style={{ fontSize: "11.5px", letterSpacing: ".05em", ...white }}>TOTAL RECEIVED · {period.label.toUpperCase()}</div>
          <div className="big-num mt8">{fmt(r.total)}</div>
          <div style={{ height: 1, background: "rgba(255,255,255,.14)", margin: "13px 0" }} />
          <div className="kv" style={white}><span>Cash</span><span className="mono">{fmt(r.cash)}</span></div>
          <div className="kv" style={white}><span>UPI / account</span><span className="mono">{fmt(r.upi)}</span></div>
          <div className="kv" style={white}><span>Credits redeemed</span><span className="mono">{fmt(r.credit)}</span></div>
          <div className="kv" style={white}><span>Refunds</span><span className="mono">−{fmt(r.refunds)}</span></div>
          <div className="kv" style={white}><span>Cash payouts</span><span className="mono">−{fmt(r.cashOut)}</span></div>
        </div>

        {/* Exports */}
        <div className="sec-title mt20">Excel exports</div>
        <div className="row gap8 wrap">
          <a className="btn xs sec" href={`/api/export/xlsx?${qs({ type: "full" })}`}>Full report</a>
          <a className="btn xs sec" href={`/api/export/xlsx?${qs({ type: "transactions" })}`}>Transactions</a>
          <a className="btn xs sec" href={`/api/export/xlsx?${qs({ type: "gst" })}`}>GST invoices</a>
          <a className="btn xs sec" href={`/api/export/xlsx?${qs({ type: "expenses" })}`}>Expenses</a>
        </div>

        {/* Cash drawer (day view) */}
        {period.kind === "day" && (
          <>
            <div className="between mt20" style={{ padding: "0 4px 10px" }}>
              <span className="sec-title" style={{ padding: 0 }}>Cash drawer</span>
              {staff.role >= 2 && <CloseDayButton expected={r.expectedDrawer} closed={!!dayClose} variance={dayClose ? N(dayClose.variance) : undefined} />}
            </div>
            <div className="card pad">
              <div className="kv"><span className="k">Opening float</span><span className="mono">{fmt(r.openingFloat)}</span></div>
              <div className="kv"><span className="k">Cash received</span><span className="mono">{fmt(r.cash)}</span></div>
              <div className="kv"><span className="k">Cash refunds</span><span className="mono">−{fmt(r.cashRefunds)}</span></div>
              <div className="kv"><span className="k">Cash payouts</span><span className="mono">−{fmt(r.cashOut)}</span></div>
              <div className="kv"><span className="k">Cash expenses</span><span className="mono">−{fmt(r.cashExpenses)}</span></div>
              <div className="kv total"><span>Expected in drawer</span><span className="mono">{fmt(r.expectedDrawer)}</span></div>
            </div>
          </>
        )}

        {/* Tax & GST */}
        <div className="sec-title mt20">Tax &amp; GST</div>
        <div className="card pad">
          <div className="kv"><span className="k">Taxable value (account only)</span><span className="mono">{fmt(r.taxable)}</span></div>
          <div className="kv"><span className="k">GST collected</span><span className="mono">{fmt(r.gstCollected)}</span></div>
          <div className="kv"><span className="k">Credit-note GST</span><span className="mono">−{fmt(r.cnGst)}</span></div>
          <div className="kv total"><span>Net GST payable</span><span className="mono">{fmt(r.netGst)}</span></div>
          <div className="muted mt8" style={{ fontSize: "12px" }}>Cash &amp; credit receipts ({fmt(r.nonGstBucket)}) are outside GST.</div>
        </div>

        {/* Invoice register — every tax document in the period, tap to open */}
        <div className="between mt20" style={{ padding: "0 4px 10px" }}>
          <span className="sec-title" style={{ padding: 0 }}>Invoices</span>
          <span className="pill gray">{r.invoices.length}{r.creditNotes.length ? ` + ${r.creditNotes.length} CN` : ""}</span>
        </div>
        <div className="card pad">
          {r.invoices.length === 0 && r.creditNotes.length === 0 ? (
            <div className="muted center" style={{ fontSize: "13px", padding: "8px 0" }}>No invoices in this period</div>
          ) : (
            <>
              {r.invoices.slice(0, 25).map((inv) => (
                <a key={inv.id} href={`/api/export/invoice/${inv.orderId}`} target="_blank" className="kv" style={{ display: "flex" }}>
                  <span className="k">
                    <span className="mono" style={{ color: "var(--teal-dark)", fontWeight: 600 }}>{inv.number}</span>
                    <span className="muted" style={{ fontSize: 12 }}> · #{inv.orderId.slice(-4)} · {inv.method.toUpperCase()} · {timeAgo(inv.at.getTime())}</span>
                  </span>
                  <span className="mono">{fmt(N(inv.total))}</span>
                </a>
              ))}
              {r.invoices.length > 25 && (
                <div className="muted center" style={{ fontSize: "12px", padding: "6px 0" }}>+ {r.invoices.length - 25} more — use the Excel export for the full list</div>
              )}
              {r.creditNotes.map((cn) => (
                <div key={cn.id} className="kv">
                  <span className="k">
                    <span className="mono" style={{ color: "var(--red)", fontWeight: 600 }}>{cn.number}</span>
                    <span className="muted" style={{ fontSize: 12 }}> · #{cn.orderId.slice(-4)} · {cn.reason || "credit note"}</span>
                  </span>
                  <span className="mono" style={{ color: "var(--red)" }}>−{fmt(N(cn.total))}</span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Operations */}
        <div className="sec-title mt20">Operations</div>
        <div className="card pad">
          <div className="kv"><span className="k">Orders received</span><span className="mono">{r.ordersIn}</span></div>
          <div className="kv"><span className="k">Orders completed</span><span className="mono">{r.ordersDone}</span></div>
          <div className="kv"><span className="k">Avg turnaround</span><span className="mono">{r.avgTurnaround.toFixed(1)} h</span></div>
          <div className="kv"><span className="k">Avg rating</span><span className="mono">{r.avgRating ? r.avgRating.toFixed(1) + " ★" : "—"}</span></div>
          <div className="kv"><span className="k">Compensation</span><span className="mono">{r.compCount} · {fmt(r.compCredit + r.compCash)}</span></div>
        </div>

        {/* Analytics */}
        <div className="sec-title mt20">Analytics</div>
        <div className="card pad">
          <div className="label" style={{ marginBottom: 10 }}>Revenue · last 8 weeks</div>
          <div className="row" style={{ alignItems: "flex-end", gap: 6, height: 76 }}>
            {weeks.map((w, i) => (
              <div key={i} className="grow" style={{ background: i === 7 ? "var(--teal)" : "var(--teal-soft)", borderRadius: 6, height: `${Math.max(6, Math.round((w / maxWeek) * 100))}%` }} title={fmt(w)} />
            ))}
          </div>
          <div className="divider" />
          <div className="kv"><span className="k">Repeat customers</span><span className="mono">{repeatRate}%</span></div>
          <div className="kv"><span className="k">Active subscribers</span><span className="mono">{activeSubs}</span></div>
          <div className="label mt12" style={{ marginBottom: 8 }}>Subscriber vs pay-per-use revenue</div>
          <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden" }}>
            <div style={{ width: `${cohortPct}%`, background: "var(--teal)" }} />
            <div style={{ flex: 1, background: "var(--amber-soft)" }} />
          </div>
          <div className="between mt4" style={{ fontSize: "11.5px" }}>
            <span className="muted">Subscribers {cohortPct}%</span>
            <span className="muted">Pay-per-use {100 - cohortPct}%</span>
          </div>
        </div>

        {/* Expenses & net */}
        <div className="between mt20" style={{ padding: "0 4px 10px" }}>
          <span className="sec-title" style={{ padding: 0 }}>Expenses &amp; net</span>
          {staff.role >= 2 && <ExpenseButton />}
        </div>
        <div className="card pad">
          {r.expenses.length ? (
            r.expenses.map((e) => (
              <div key={e.id} className="kv">
                <span className="k">
                  {e.category}
                  {e.note ? <span className="muted" style={{ fontSize: 12 }}> · {e.note}</span> : null}
                  {e.receiptKey ? <a href={`/api/receipt?key=${encodeURIComponent(e.receiptKey)}`} target="_blank" style={{ color: "var(--teal)", fontSize: 12 }}> · receipt</a> : null}
                </span>
                <span className="mono">−{fmt(N(e.amount))}</span>
              </div>
            ))
          ) : (
            <div className="muted" style={{ fontSize: 13.5 }}>No expenses in this period</div>
          )}
          <div className="kv total"><span>Net (collections − expenses)</span><span className="mono">{fmt(r.net)}</span></div>
        </div>

        {/* Transactions */}
        <div className="sec-title mt20">Transactions</div>
        <div className="list">
          {r.payments.slice(0, 30).map((p) => (
            <div key={p.id} className="list-item">
              <div className="icon-tile" style={{ width: 36, height: 36, background: N(p.amount) < 0 ? "var(--red-soft)" : "var(--teal-soft)", color: N(p.amount) < 0 ? "var(--red)" : "var(--teal-dark)" }}>
                <Svg name={p.method === "cash" || p.method === "cash_out" ? "wallet" : p.method === "credit" ? "gift" : "qr"} size={17} />
              </div>
              <div className="grow">
                <div style={{ fontSize: 14, fontWeight: 550 }}>
                  {p.method}{p.orderId ? " · #" + p.orderId.slice(-4) : ""}{p.gatewayRef ? " · " + p.gatewayRef : ""}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{p.note || ""} {timeAgo(p.at)}</div>
              </div>
              <span className="mono" style={{ fontWeight: 650, color: N(p.amount) < 0 ? "var(--red)" : "var(--ink)" }}>
                {N(p.amount) < 0 ? "−" : ""}{fmt(Math.abs(N(p.amount)))}
              </span>
            </div>
          ))}
          {!r.payments.length && <div className="list-item muted">No transactions in this period</div>}
        </div>

        {/* Complaints + audit + email */}
        <div className="card pad mt16">
          <div className="kv"><span className="k">Complaints in period</span><span className="mono">{r.complaints.length}</span></div>
        </div>
        <div className="row gap8 mt12">
          <EmailReportButton />
          {staff.role >= 3 && (
            <Link className="btn xs sec" href="/s/audit"><Svg name="shield" size={14} /> Audit log</Link>
          )}
        </div>
        <div style={{ height: 12 }} />
        {r.compensations.length > 0 && (
          <div className="muted" style={{ fontSize: 12, padding: "0 4px" }}>
            Compensation detail: {r.compensations.map((c) => `${c.kind} ${fmt(N(c.amount))} (${c.method}) by ${byId(c.by)}`).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}
