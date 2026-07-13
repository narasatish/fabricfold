/* Report period + aggregation shared by Reports screen, XLSX exports and the
   daily email — formulas ported from the prototype's staffReports(). */
import { db } from "./db";

export type Period = { kind: "day" | "week" | "month" | "year" | "all"; from: Date | null; to: Date | null; label: string };

export function parsePeriod(sp: { p?: string; d?: string; m?: string; y?: string }): Period {
  const kind = (sp.p as Period["kind"]) || "day";
  if (kind === "day") {
    const d = sp.d ? new Date(sp.d + "T00:00:00") : new Date(new Date().toDateString());
    return { kind, from: d, to: new Date(d.getTime() + 86_400_000), label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) };
  }
  if (kind === "week") {
    // the week (Mon–Sun) containing the given date (?d=), defaulting to today
    const ref = sp.d ? new Date(sp.d + "T00:00:00") : new Date(new Date().toDateString());
    const dow = (ref.getDay() + 6) % 7; // 0 = Monday
    const from = new Date(ref.getTime() - dow * 86_400_000);
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const f = (x: Date) => x.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    return { kind, from, to, label: `Week ${f(from)} – ${f(new Date(to.getTime() - 86_400_000))}` };
  }
  if (kind === "month") {
    const [y, m] = (sp.m || new Date().toISOString().slice(0, 7)).split("-").map(Number);
    const from = new Date(y, m - 1, 1);
    return { kind, from, to: new Date(y, m, 1), label: from.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
  }
  if (kind === "year") {
    const y = Number(sp.y || new Date().getFullYear());
    return { kind, from: new Date(y, 0, 1), to: new Date(y + 1, 0, 1), label: String(y) };
  }
  return { kind: "all", from: null, to: null, label: "All time" };
}

const inRange = (p: Period) => (p.from ? { gte: p.from, lt: p.to! } : undefined);

export async function computeReport(p: Period) {
  const at = inRange(p);
  const [payments, invoices, creditNotes, expenses, orders, compensations, complaints, cfg] = await Promise.all([
    db.payment.findMany({ where: at ? { at } : {}, orderBy: { at: "desc" } }),
    db.invoice.findMany({ where: at ? { at } : {}, orderBy: { at: "desc" } }),
    db.creditNote.findMany({ where: at ? { at } : {}, orderBy: { at: "desc" } }),
    db.expense.findMany({ where: at ? { at } : {}, orderBy: { at: "desc" } }),
    db.order.findMany({ where: at ? { createdAt: at } : {}, include: { timeline: true } }),
    db.compensation.findMany({ where: at ? { at } : {} }),
    db.complaint.findMany({ where: at ? { at } : {} }),
    db.appConfig.findUniqueOrThrow({ where: { id: "main" } }),
  ]);

  const N = (x: unknown) => Number(x || 0);
  const recv = (m: string) => payments.filter((x) => x.method === m && N(x.amount) > 0).reduce((s, x) => s + N(x.amount), 0);
  const cash = recv("cash"), upi = recv("upi"), credit = recv("credit");
  const refunds = -payments.filter((x) => x.method === "refund").reduce((s, x) => s + N(x.amount), 0);
  const cashOut = -payments.filter((x) => x.method === "cash_out").reduce((s, x) => s + N(x.amount), 0);
  const cashRefunds = -payments.filter((x) => x.method === "refund" && x.refundVia === "cash").reduce((s, x) => s + N(x.amount), 0);
  const total = cash + upi + credit;

  const expTotal = expenses.reduce((s, x) => s + N(x.amount), 0);
  const cashExpenses = expenses.filter((x) => x.method === "cash").reduce((s, x) => s + N(x.amount), 0);
  const settings = cfg.settings as { openingFloat?: number };
  const openingFloat = N(settings.openingFloat);
  // drawer math (day view): opening float + cash in − cash refunds − cash payouts − cash expenses
  const expectedDrawer = openingFloat + cash - cashRefunds - cashOut - cashExpenses;

  // Tax & GST — account (UPI) payments only carry invoices
  const taxable = invoices.reduce((s, x) => s + N(x.subtotal), 0);
  const gstCollected = invoices.reduce((s, x) => s + N(x.gst), 0);
  const cnGst = creditNotes.reduce((s, x) => s + N(x.gst), 0);
  const netGst = gstCollected - cnGst;
  const nonGstBucket = cash + credit;

  // operations
  const done = orders.filter((o) => o.status === "collected");
  const turnarounds = done
    .map((o) => {
      const r = o.timeline.find((t) => t.status === "received")?.at.getTime();
      const c = o.timeline.find((t) => t.status === "collected")?.at.getTime();
      return r && c ? (c - r) / 3_600_000 : null;
    })
    .filter((x): x is number => x != null);
  const avgTurnaround = turnarounds.length ? turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length : 0;
  const rated = orders.filter((o) => o.rating);
  const avgRating = rated.length ? rated.reduce((s, o) => s + (o.rating || 0), 0) / rated.length : 0;

  const compCredit = compensations.filter((c) => c.method === "credit").reduce((s, c) => s + N(c.amount), 0);
  const compCash = compensations.filter((c) => c.method === "cash").reduce((s, c) => s + N(c.amount), 0);

  return {
    payments, invoices, creditNotes, expenses, orders, compensations, complaints,
    cash, upi, credit, total, refunds, cashOut,
    openingFloat, cashRefunds, cashExpenses, expectedDrawer,
    taxable, gstCollected, cnGst, netGst, nonGstBucket,
    ordersIn: orders.length, ordersDone: done.length, avgTurnaround, avgRating,
    compCredit, compCash, compCount: compensations.length,
    expTotal, net: total - refunds - cashOut - expTotal,
  };
}

export async function reportText(p: Period) {
  const r = await computeReport(p);
  const f = (n: number) => "Rs " + n.toLocaleString("en-IN");
  return [
    `FabricFold report — ${p.label}`,
    ``,
    `COLLECTIONS`,
    `Cash: ${f(r.cash)}  UPI: ${f(r.upi)}  Credits: ${f(r.credit)}`,
    `Total received: ${f(r.total)}  Refunds: ${f(r.refunds)}  Cash payouts: ${f(r.cashOut)}`,
    ``,
    `TAX & GST (account payments only)`,
    `Taxable: ${f(r.taxable)}  GST collected: ${f(r.gstCollected)}  CN GST: ${f(r.cnGst)}  Net GST payable: ${f(r.netGst)}`,
    ``,
    `OPERATIONS`,
    `Orders in: ${r.ordersIn}  Completed: ${r.ordersDone}  Avg turnaround: ${r.avgTurnaround.toFixed(1)}h  Avg rating: ${r.avgRating.toFixed(1)}`,
    ``,
    `EXPENSES ${f(r.expTotal)} · NET ${f(r.net)}`,
    `Complaints: ${r.complaints.length}`,
  ].join("\n");
}
