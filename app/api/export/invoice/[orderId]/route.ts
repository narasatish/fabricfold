/* Printable GST tax invoice (HTML → user prints to PDF). Accessible to the
   order's student or any staff. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(_req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await ctx.params;
  const s = await getSession();
  if (!s) return new Response("unauthorized", { status: 401 });

  const inv = await db.invoice.findUnique({ where: { orderId }, include: { order: { include: { student: true } }, creditNotes: true } });
  if (!inv) return new Response("no invoice for this order", { status: 404 });
  if (s.mode === "customer" && s.studentId !== inv.studentId) return new Response("forbidden", { status: 403 });

  const o = inv.order;
  const items = o.items as unknown as { label: string; rate: number; qty: number }[];
  const N = (x: unknown) => Number(x || 0);
  const money = (n: number) => "₹" + n.toLocaleString("en-IN");
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const pay = cfg.payment as { payeeName?: string };

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${inv.number}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;max-width:640px;margin:32px auto;color:#12211c;padding:0 16px}
h1{font-size:20px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px 10px;border-bottom:1px solid #e7ede9;text-align:left;font-size:14px}
th{font-size:12px;text-transform:uppercase;color:#7a8a83}.r{text-align:right}.tot{font-weight:700;font-size:16px}
.muted{color:#7a8a83;font-size:12.5px}@media print{button{display:none}}</style></head><body>
<h1>FabricFold — Tax Invoice</h1>
<div class="muted">${pay.payeeName || "FabricFold Laundry"} · Invoice <b>${inv.number}</b> · ${inv.at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</div>
<div class="muted">Billed to: ${o.student.name} (FF ID ${o.student.id}) · Order #${o.id}</div>
<table><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr>
${items.map((i) => `<tr><td>${i.label}</td><td class="r">${i.qty}</td><td class="r">${money(i.rate)}</td><td class="r">${money(i.rate * i.qty)}</td></tr>`).join("")}
${N(o.surcharge) ? `<tr><td>Express surcharge</td><td class="r"></td><td class="r"></td><td class="r">${money(N(o.surcharge))}</td></tr>` : ""}
<tr><td colspan="3" class="r">Taxable value</td><td class="r">${money(N(inv.subtotal))}</td></tr>
<tr><td colspan="3" class="r">GST @ ${N(inv.gstPct)}%</td><td class="r">${money(N(inv.gst))}</td></tr>
<tr class="tot"><td colspan="3" class="r">Total</td><td class="r">${money(N(inv.total))}</td></tr></table>
${inv.creditNotes.length ? `<div class="muted">Credit notes: ${inv.creditNotes.map((c) => `${c.number} (−${money(N(c.total))})`).join(", ")}</div>` : ""}
<div class="muted">Payment method: ${inv.method.toUpperCase()}</div>
<button onclick="window.print()" style="margin-top:18px;padding:10px 18px;border-radius:10px;border:none;background:#0f8a66;color:#fff;font-weight:600">Print / Save PDF</button>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
