/* Named tools the owner can grant or revoke per staff member.

   Roles stay the backbone — Counter, Manager, Admin, Owner — and each tool
   has a role default. The override map on Staff.perms bends individuals
   without minting a new role for every trust decision: a veteran counter
   member can be GRANTED refunds; a manager the owner is unsure of can have
   money reports REVOKED.

   The list is deliberately short and money-shaped, because that is what the
   owner asked to control: "we can't provide sensitive data or anything
   related to accounting to staff". A permission nobody can explain at the
   counter is a permission nobody audits. */

export const PERM_DEFS = {
  reports: {
    label: "Money reports & exports",
    hint: "Revenue, GST, drawer figures, Excel downloads",
    minRole: 2,
  },
  refunds: {
    label: "Refunds & compensation",
    hint: "Give money or credit back to a student",
    minRole: 2,
  },
  dayclose: {
    label: "Day close (cash drawer)",
    hint: "Count and reconcile the drawer at closing",
    minRole: 2,
  },
} as const;

export type PermKey = keyof typeof PERM_DEFS;

/**
 * Can this staff member use this tool?
 *
 * Owners always can — a control panel that can lock out its own owner is a
 * footgun, not a feature. For everyone else the override wins when present
 * (true grants, false revokes) and the role default decides otherwise.
 */
export function staffCan(staff: { role: number; perms?: unknown }, key: PermKey): boolean {
  if (staff.role >= 4) return true;
  const o = (staff.perms ?? {}) as Record<string, unknown>;
  if (typeof o[key] === "boolean") return o[key] as boolean;
  return staff.role >= PERM_DEFS[key].minRole;
}
