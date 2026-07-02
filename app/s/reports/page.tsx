import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffReportsClient from "./_components/ReportsClient";

export default async function StaffReportsPage() {
  await requireStaff(2);

  // Fetch all data needed for reports
  const [payments, invoices, creditNotes, expenses, orders, complaints, appConfig] = await Promise.all([
    db.payment.findMany({ include: { order: true } }),
    db.invoice.findMany(),
    db.creditNote.findMany(),
    db.expense.findMany(),
    db.order.findMany({ where: { status: "collected" } }),
    db.complaint.findMany(),
    db.appConfig.findUnique({ where: { id: "main" } }),
  ]);

  return (
    <div className="screen">
      <TopBar title="Reports" sub="" back={null} />
      <StaffReportsClient
        payments={payments}
        invoices={invoices}
        creditNotes={creditNotes}
        expenses={expenses}
        orders={orders}
        complaints={complaints}
        appConfig={appConfig}
      />
    </div>
  );
}
