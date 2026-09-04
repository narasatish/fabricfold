/* B2B monthly statement for a campus — printable HTML the owner can send to
   college administration: orders, revenue by service, payment split, GST.
   Admin+ only. /api/export/college-statement?collegeId=…&m=YYYY-MM */
import { db } from "@/lib/db";
import { requireStaff, assertSameCollege } from "@/lib/auth";

export const dynamic = "force-dynamic";

const SERVICE_LABEL: Record<string, string> = { washIron: "Wash & Iron", washFold: "Wash & Fold", ironOnly: "Iron Only", dryClean: "Dry Clean" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export async function GET(req: Request) {
  let staff;
  try {
    staff = await requireStaff(3);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const collegeId = url.searchParams.get("collegeId") || "";
  const m = url.searchParams.get("m") || new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return new Response("bad month", { status: 400 });
  const from = new Date(y, mo - 1, 1), to = new Date(y, mo, 1);

  try {
    assertSameCollege(staff, collegeId);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const college = await db.college.findUnique({ where: { id: collegeId } });
  if (!college) return new Response("college not found", { status: 404 });

  const [orders, payments, invoices, students] = await Promise.all([
    db.order.findMany({ where: { collegeId, createdAt: { gte: from, lt: to }, status: { not: "cancelled" } } }),
    db.payment.findMany({ where: { collegeId, at: { gte: from, lt: to }, amount: { gt: 0 }, method: { in: ["cash", "upi", "credit"] } } }),
    db.invoice.findMany({ where: { collegeId, at: { gte: from, lt: to } } }),
    db.student.count({ where: { collegeId } }),
  ]);

  const N = (x: unknown) => Number(x || 0);
  const byService = new Map<string, { orders: number; pieces: number; value: number }>();
  for (const o of orders) {
    const s = byService.get(o.service) || { orders: 0, pieces: 0, value: 0 };
    s.orders++; s.pieces += o.actualPieces ?? o.declaredPieces ?? 0; s.value += N(o.total);
    byService.set(o.service, s);
  }
  const totalCollected = payments.reduce((s, p) => s + N(p.amount), 0);
  const byMethod = (mm: string) => payments.filter((p) => p.method === mm).reduce((s, p) => s + N(p.amount), 0);
  const gst = invoices.reduce((s, i) => s + N(i.gst), 0);
  const label = from.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>FabricFold — ${esc(college.name)} — ${label}</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;color:#12211c;margin:40px auto;max-width:720px;padding:0 24px}
  h1{font-size:22px;margin:0} h2{font-size:15px;margin:28px 0 8px;color:#0a6e55}
  .muted{color:#71827b;font-size:13px} table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{padding:8px 10px;border-bottom:1px solid #e5ece8;font-size:13.5px;text-align:left}
  th{background:#e2f5ee;color:#0a6e55} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .total td{font-weight:700;border-top:2px solid #0e9271}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0e9271;padding-bottom:14px}
  @media print{body{margin:10px auto}}
</style></head><body>
<div class="head">
  <div><h1>FabricFold</h1><div class="muted">Campus laundry & dry-cleaning · fabricfold.in</div></div>
  <div style="text-align:right"><div style="font-weight:700">Monthly statement</div><div class="muted">${esc(college.name)} · ${label}</div></div>
</div>

<h2>Activity summary</h2>
<table>
  <tr><th>Registered students</th><td class="num">${students}</td></tr>
  <tr><th>Orders this month</th><td class="num">${orders.length}</td></tr>
  <tr><th>Total collected</th><td class="num">₹${totalCollected.toLocaleString("en-IN")}</td></tr>
  <tr><th>GST collected (invoiced)</th><td class="num">₹${gst.toLocaleString("en-IN")}</td></tr>
</table>

<h2>By service</h2>
<table>
  <tr><th>Service</th><th class="num">Orders</th><th class="num">Pieces</th><th class="num">Order value</th></tr>
  ${[...byService.entries()].map(([k, v]) => `<tr><td>${esc(SERVICE_LABEL[k] || k)}</td><td class="num">${v.orders}</td><td class="num">${v.pieces}</td><td class="num">₹${v.value.toLocaleString("en-IN")}</td></tr>`).join("")}
  <tr class="total"><td>Total</td><td class="num">${orders.length}</td><td class="num">${[...byService.values()].reduce((s, v) => s + v.pieces, 0)}</td><td class="num">₹${[...byService.values()].reduce((s, v) => s + v.value, 0).toLocaleString("en-IN")}</td></tr>
</table>

<h2>Collections by method</h2>
<table>
  <tr><th>Method</th><th class="num">Amount</th></tr>
  <tr><td>UPI / online</td><td class="num">₹${byMethod("upi").toLocaleString("en-IN")}</td></tr>
  <tr><td>Cash</td><td class="num">₹${byMethod("cash").toLocaleString("en-IN")}</td></tr>
  <tr><td>Store credits redeemed</td><td class="num">₹${byMethod("credit").toLocaleString("en-IN")}</td></tr>
  <tr class="total"><td>Total</td><td class="num">₹${totalCollected.toLocaleString("en-IN")}</td></tr>
</table>

<p class="muted" style="margin-top:30px">Generated ${new Date().toLocaleString("en-IN")} · FabricFold · support@fabricfold.in · +91 80191 21966</p>
<script>window.print && setTimeout(() => {}, 0)</script>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
