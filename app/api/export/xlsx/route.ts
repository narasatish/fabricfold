/* Real XLSX exports via exceljs — full report / transactions / GST / expenses.
   Amounts are raw numbers so they sum in Excel. Staff-only. */
import ExcelJS from "exceljs";
import { requireStaff, requireStaffPerm } from "@/lib/auth";
import { parsePeriod, computeReport } from "@/lib/report";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireStaffPerm("reports");
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const type = url.searchParams.get("type") || "full";
  const p = parsePeriod(Object.fromEntries(url.searchParams) as Record<string, string>);
  const r = await computeReport(p);
  const staff = await db.staff.findMany();
  const students = await db.student.findMany();
  const byId = (id: string | null | undefined, list: { id: string; name: string }[]) => list.find((x) => x.id === id)?.name || id || "";
  const N = (x: unknown) => Number(x || 0);

  const wb = new ExcelJS.Workbook();
  wb.creator = "FabricFold";

  const addSummary = () => {
    const ws = wb.addWorksheet("Summary");
    ws.columns = [{ width: 32 }, { width: 18 }];
    const rows: [string, number | string][] = [
      ["Period", p.label],
      ["Cash received", r.cash],
      ["UPI received", r.upi],
      ["Credits redeemed", r.credit],
      ["Total received", r.total],
      ["Refunds", r.refunds],
      ["Cash payouts (compensation)", r.cashOut],
      ["Taxable value (account)", r.taxable],
      ["GST collected", r.gstCollected],
      ["Credit-note GST", r.cnGst],
      ["Net GST payable", r.netGst],
      ["Non-GST bucket (cash+credit)", r.nonGstBucket],
      ["Expenses", r.expTotal],
      ["Net", r.net],
      ["Orders received", r.ordersIn],
      ["Orders completed", r.ordersDone],
      ["Avg turnaround (h)", Number(r.avgTurnaround.toFixed(1))],
      ["Avg rating", Number(r.avgRating.toFixed(1))],
    ];
    rows.forEach(([k, v]) => ws.addRow([k, v]));
    ws.getColumn(1).font = { bold: true };
  };

  const addTransactions = () => {
    const ws = wb.addWorksheet("Transactions");
    ws.addRow(["Date", "Method", "Amount", "Order", "Student", "Note", "Gateway ref"]).font = { bold: true };
    r.payments.forEach((x) =>
      ws.addRow([x.at.toLocaleString("en-IN"), x.method, N(x.amount), x.orderId || "", byId(x.studentId, students), x.note || "", x.gatewayRef || ""]),
    );
    ws.columns.forEach((c) => (c.width = 20));
  };

  const addGst = () => {
    const ws = wb.addWorksheet("GST Invoices");
    ws.addRow(["Invoice", "Date", "Order", "Student", "Subtotal", "GST %", "GST", "Total", "Method"]).font = { bold: true };
    r.invoices.forEach((x) =>
      ws.addRow([x.number, x.at.toLocaleString("en-IN"), x.orderId, byId(x.studentId, students), N(x.subtotal), N(x.gstPct), N(x.gst), N(x.total), x.method]),
    );
    ws.columns.forEach((c) => (c.width = 18));
    const ws2 = wb.addWorksheet("Credit Notes");
    ws2.addRow(["Credit note", "Date", "Order", "Student", "Subtotal", "GST", "Total", "Reason", "Via", "By"]).font = { bold: true };
    r.creditNotes.forEach((x) =>
      ws2.addRow([x.number, x.at.toLocaleString("en-IN"), x.orderId, byId(x.studentId, students), N(x.subtotal), N(x.gst), N(x.total), x.reason, x.via, byId(x.by, staff)]),
    );
    ws2.columns.forEach((c) => (c.width = 18));
  };

  const addExpenses = () => {
    const ws = wb.addWorksheet("Expenses");
    ws.addRow(["Date", "Category", "Amount", "Method", "By", "Note", "Receipt"]).font = { bold: true };
    r.expenses.forEach((x) => ws.addRow([x.at.toLocaleString("en-IN"), x.category, N(x.amount), x.method, byId(x.by, staff), x.note || "", x.receiptKey ? "yes" : ""]));
    ws.columns.forEach((c) => (c.width = 20));
  };

  if (type === "full") { addSummary(); addTransactions(); addGst(); addExpenses(); }
  else if (type === "transactions") addTransactions();
  else if (type === "gst") addGst();
  else if (type === "expenses") addExpenses();
  else addSummary();

  const buf = await wb.xlsx.writeBuffer();
  const fname = `fabricfold-${type}-${p.label.replace(/[^\w]+/g, "-").toLowerCase()}.xlsx`;
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}
