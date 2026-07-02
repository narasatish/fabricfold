/* Customer monthly statement (XLSX): orders + payments + credit activity. */
import ExcelJS from "exceljs";
import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let stu;
  try {
    stu = await requireStudent();
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const m = url.searchParams.get("m") || new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const from = new Date(y, mo - 1, 1), to = new Date(y, mo, 1);
  const N = (x: unknown) => Number(x || 0);

  const [orders, payments, comps, uses] = await Promise.all([
    db.order.findMany({ where: { studentId: stu.id, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "desc" } }),
    db.payment.findMany({ where: { studentId: stu.id, at: { gte: from, lt: to } }, orderBy: { at: "desc" } }),
    db.compensation.findMany({ where: { studentId: stu.id, method: "credit", at: { gte: from, lt: to } } }),
    db.creditUse.findMany({ where: { studentId: stu.id, at: { gte: from, lt: to } } }),
  ]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Statement");
  ws.addRow([`FabricFold statement — ${stu.name} (${stu.id}) — ${m}`]).font = { bold: true, size: 14 };
  ws.addRow([]);
  ws.addRow(["ORDERS"]).font = { bold: true };
  ws.addRow(["Date", "Order", "Service", "Pieces", "Status", "Total", "Paid via"]).font = { bold: true };
  orders.forEach((o) => ws.addRow([o.createdAt.toLocaleDateString("en-IN"), o.id, o.service, o.actualPieces || o.declaredPieces, o.status, N(o.total), o.paymentMethod || ""]));
  ws.addRow([]);
  ws.addRow(["PAYMENTS"]).font = { bold: true };
  ws.addRow(["Date", "Method", "Amount", "Order"]).font = { bold: true };
  payments.forEach((x) => ws.addRow([x.at.toLocaleDateString("en-IN"), x.method, N(x.amount), x.orderId || ""]));
  ws.addRow([]);
  ws.addRow(["CREDIT ACTIVITY"]).font = { bold: true };
  ws.addRow(["Date", "Type", "Amount"]).font = { bold: true };
  comps.forEach((c) => ws.addRow([c.at.toLocaleDateString("en-IN"), "Credit added (" + c.kind + ")", N(c.amount)]));
  uses.forEach((u) => ws.addRow([u.at.toLocaleDateString("en-IN"), "Credit used", -N(u.amount)]));
  ws.columns.forEach((c) => (c.width = 18));

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="fabricfold-statement-${m}.xlsx"`,
    },
  });
}
