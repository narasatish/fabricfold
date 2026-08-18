import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffAuditClient from "./_components/AuditClient";

export default async function StaffAuditPage() {
  const staff = await requireStaff(3);

  const logs = await db.auditLog.findMany({
    orderBy: { at: "desc" },
  });

  /* Resolve the actor to a NAME.

     AuditLog.by holds a raw staff id and has no relation to Staff, so the
     screen was rendering "cmr8n8ffm000fbkbul5y2gbs0 - 2d ago". This is the
     record you reach for after a dispute about who cancelled an order or
     issued a refund, and it named nobody.

     Resolved here rather than by adding a relation, because `by` is not always
     a staff id: config edits applied from the Google Sheet are recorded as
     "sheet", and a foreign key would reject those. Anything unrecognised falls
     back to the raw value rather than being hidden. */
  const staffRows = await db.staff.findMany({ select: { id: true, name: true, role: true } });
  const ROLE: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
  const nameOf = (by: string) => {
    const s = staffRows.find((x) => x.id === by);
    if (s) return `${s.name} · ${ROLE[s.role] ?? "staff"}`;
    if (by === "sheet") return "Google Sheet edit";
    return by;
  };

  return (
    <div className="screen">
      <TopBar title="Audit log" sub="" back={undefined} />
      <StaffAuditClient logs={logs.map((l) => ({ ...l, by: nameOf(l.by) }))} />
    </div>
  );
}
