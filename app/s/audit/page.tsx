import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffAuditClient from "./_components/AuditClient";

export default async function StaffAuditPage() {
  const staff = await requireStaff(3);

  /* CRITICAL campus-isolation gap, found 2026-09-05: AuditLog has no
     collegeId column at all — it only records a raw actor id (`by`) — so
     this query was fetching and showing EVERY campus's audit trail (every
     refund, cancellation, cash compensation, admin action, company-wide) to
     any Admin, not just Owner. A campus-scoped Admin at one college could
     read the full audit history of every other college.

     A proper fix needs a schema migration (add AuditLog.collegeId) and
     touching every audit() call site across the codebase to pass it — too
     large a change to land safely in one sitting. This is the pragmatic
     interim fix: filter by the ACTING STAFF MEMBER's own collegeId, the
     same signal `assertSameCollege` already uses everywhere else to decide
     who can act on what. It isn't perfect — a "sheet" edit (config changes
     applied from the Google Sheet, not tied to any staff id) can't be
     attributed to a campus at all, so those rows are hidden from
     campus-scoped Admins entirely rather than guessed at or shown to
     everyone. Owner (collegeId null) still sees everything, unfiltered,
     exactly as before. See docs/claude-playbook.md for the full writeup and
     the real fix this defers to. */
  const staffRows = await db.staff.findMany({ select: { id: true, name: true, role: true, collegeId: true } });
  const staffById = new Map(staffRows.map((s) => [s.id, s]));

  const allLogs = await db.auditLog.findMany({ orderBy: { at: "desc" } });
  const logs = staff.collegeId
    ? allLogs.filter((l) => staffById.get(l.by)?.collegeId === staff.collegeId)
    : allLogs;

  /* Resolve the actor to a NAME.

     AuditLog.by holds a raw staff id and has no relation to Staff, so the
     screen was rendering "cmr8n8ffm000fbkbul5y2gbs0 - 2d ago". This is the
     record you reach for after a dispute about who cancelled an order or
     issued a refund, and it named nobody.

     Resolved here rather than by adding a relation, because `by` is not always
     a staff id: config edits applied from the Google Sheet are recorded as
     "sheet", and a foreign key would reject those. Anything unrecognised falls
     back to the raw value rather than being hidden. */
  const ROLE: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
  const nameOf = (by: string) => {
    const s = staffById.get(by);
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
