"use server";
/* Admin: rates & GST, plan, payment details, colleges + feature flags, staff,
   expenses (Manager+), payroll (Admin+). All sensitive edits audit-logged. */
import { db } from "../db";
import { FEATURE_DEFAULTS, featureOn, type FeatureKey } from "../features";
import { requireStaff } from "../auth";
import { PERM_DEFS } from "../perms";
import { rosterSoon } from "../sheets-sync";
import { audit } from "../notify";
import { publish } from "../realtime";
import { notifyOwner } from "../mail";
import { assignWashDay } from "../washday-server";
import { isTier } from "../bagcode";

/* ----- Register a student at the counter (any staff) -----
   Students cannot self-register — this is the ONLY way a student account is
   created. verifyOtp() will reject an unrecognised number with a message to
   come to the counter. */
export async function registerStudent(input: { name: string; phone: string; collegeId: string; kind?: "student" | "faculty" }) {
  const st = await requireStaff(1);
  const name = input.name.trim();
  const phone = input.phone.replace(/\D/g, "").slice(-10);
  if (name.length < 2) return { ok: false as const, error: "Enter the student's name" };
  if (phone.length !== 10) return { ok: false as const, error: "Enter a valid 10-digit mobile number" };
  if (await db.student.findUnique({ where: { phone } })) return { ok: false as const, error: "This number is already registered" };
  const college = await db.college.findUnique({ where: { id: input.collegeId } });
  if (!college || !college.active) return { ok: false as const, error: "Pick a campus" };

  // permanent random 6-digit FabricFold code, unique (same scheme as self-registration)
  let id = "";
  for (let i = 0; i < 20; i++) {
    id = String(Math.floor(100000 + Math.random() * 900000));
    if (!(await db.student.findUnique({ where: { id } }))) break;
  }
  const kind = input.kind === "faculty" ? "faculty" : "student";
  const stu = await db.student.create({ data: { id, phone, name, collegeId: college.id, kind } });
  // Wash day rota PARKED (owner, Sep 2026): students drop off any day, so no
  // day is assigned. assignWashDay and the data stay for when it returns.
  await audit(kind === "faculty" ? "Faculty registered" : "Student registered", `${name} · +91 ${phone} · ${college.name}`, st.id);
  rosterSoon();
  void notifyOwner("New student registered", `${name} (+91 ${phone}) registered at the counter (${college.name}) by ${st.name} — ID ${stu.id}.`);
  return { ok: true as const, id: stu.id };
}

/* ----- Change a student's registered mobile number (Admin+ only) -----
   Students have no self-service way to change their number — by design, so a
   lost/stolen phone can't be used to silently take over an account. They must
   come to the counter and an Admin makes the change here. */
export async function updateStudentPhone(studentId: string, newPhone: string) {
  const st = await requireStaff(3);
  const phone = newPhone.replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return { ok: false as const, error: "Enter a valid 10-digit mobile number" };
  const existing = await db.student.findUnique({ where: { phone } });
  if (existing && existing.id !== studentId) return { ok: false as const, error: "This number is already registered to another student" };
  const stu = await db.student.findUnique({ where: { id: studentId } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  await db.student.update({ where: { id: studentId }, data: { phone } });
  await audit("Student phone changed", `${stu.name} (${stu.id}) · +91 ${stu.phone} -> +91 ${phone}`, st.id);
  rosterSoon();
  return { ok: true as const };
}

/**
 * Edit a student's details: name, campus, wash day.
 *
 * Phone is deliberately NOT here — it stays in updateStudentPhone, because
 * changing the number changes who can log into the account and deserves its
 * own deliberate action rather than riding along with a typo fix.
 *
 * Admin+ throughout. A counter member correcting a spelling is fine in
 * principle, but campus and wash day move a student between operational
 * groups, and splitting the permission per field would be a rule nobody
 * remembers at a busy counter.
 */
export async function updateStudentDetails(
  studentId: string,
  input: { name?: string; collegeId?: string; washDay?: number | null },
) {
  const st = await requireStaff(3);
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: { include: { planRef: true } } } });
  if (!stu) return { ok: false as const, error: "Student not found" };

  const data: { name?: string; collegeId?: string; washDay?: number | null } = {};
  const changes: string[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60) return { ok: false as const, error: "Enter a valid name" };
    if (name !== stu.name) { data.name = name; changes.push(`name ${stu.name} → ${name}`); }
  }

  /* Moving campus is the one that is not a simple field edit.

     A plan belongs to a campus — assignSubscription refuses a plan from a
     different one — so moving a student who holds an active plan would leave
     them subscribed to something their new campus does not sell, and neither
     screen would show it as wrong. Cancel or let the plan lapse first.

     Past orders keep the campus they were placed at. They are a record of
     where the work was done, and rewriting them would misstate every
     per-campus statement already issued. */
  if (input.collegeId !== undefined && input.collegeId !== stu.collegeId) {
    const college = await db.college.findUnique({ where: { id: input.collegeId } });
    if (!college) return { ok: false as const, error: "Campus not found" };
    if (!college.active) return { ok: false as const, error: `${college.name} has been removed — restore it first` };
    if (stu.subscription?.active) {
      return {
        ok: false as const,
        error: `${stu.name} holds an active ${stu.subscription.plan}, which belongs to their current campus. Cancel the plan first, then move them.`,
      };
    }
    const open = await db.order.count({ where: { studentId, status: { notIn: ["collected", "cancelled"] } } });
    if (open) return { ok: false as const, error: `${open} order(s) still open at their current campus — finish those first` };

    data.collegeId = college.id;
    const from = await db.college.findUnique({ where: { id: stu.collegeId }, select: { name: true } });
    changes.push(`campus ${from?.name ?? stu.collegeId} → ${college.name}`);
    /* Wash days are balanced per campus, so a day that made sense at the old
       one means nothing at the new. Cleared here and reassigned below. */
    data.washDay = null;
  }

  if (input.washDay !== undefined && data.washDay === undefined) {
    const wd = input.washDay;
    if (wd !== null) {
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { ok: false as const, error: "Pick a weekday" };
      const college = await db.college.findUnique({ where: { id: data.collegeId ?? stu.collegeId }, select: { closedWeekday: true } });
      if (college?.closedWeekday === wd) return { ok: false as const, error: "That is the campus's closed day" };
    }
    if (wd !== stu.washDay) {
      data.washDay = wd;
      changes.push(`wash day ${stu.washDay ?? "none"} → ${wd ?? "none"}`);
    }
  }

  if (!changes.length) return { ok: true as const, changed: false };

  await db.student.update({ where: { id: studentId }, data });

  // Rota parked: a moved student simply has no wash day until it returns.

  await audit("Student updated", `${stu.name} (${stu.id}) · ${changes.join("; ")}`, st.id);
  rosterSoon();
  /* Both campuses on a move: the old one has to drop them from its wash-day
     list, and the new one has to show them. Publishing only the old channel
     would leave the receiving counter's screen wrong until a manual refresh. */
  const channels = [`student:${studentId}`, `orders:${stu.collegeId}`];
  if (data.collegeId) channels.push(`orders:${data.collegeId}`);
  publish(channels, { type: "student", payload: { studentId } });
  return { ok: true as const, changed: true, changes };
}

/* ----- Subscription plans per college (Admin+) ----- */
const SERVICES = ["washIron", "washFold", "ironOnly", "dryClean"];
export async function savePlan(input: {
  id?: string; collegeId: string; name: string; price: number; gstFree: boolean;
  tier?: string | null;
  buckets: { service: string; cycles: number; kgPerCycle: number }[];
}) {
  const st = await requireStaff(3);
  const name = input.name.trim();
  if (name.length < 2) return { ok: false as const, error: "Give the plan a name" };
  if (!input.price || input.price <= 0) return { ok: false as const, error: "Enter a valid price" };
  const buckets = input.buckets.filter((b) => SERVICES.includes(b.service) && b.cycles > 0);
  if (!buckets.length) return { ok: false as const, error: "Add at least one service with cycles" };
  const college = await db.college.findUnique({ where: { id: input.collegeId } });
  if (!college) return { ok: false as const, error: "Pick a campus" };

  // The tier decides which letter goes on the student's bag (B/S/G), so an
  // unrecognised value is stored as null rather than guessed at.
  const tier = isTier(input.tier) ? input.tier : null;
  const data = { collegeId: input.collegeId, name, price: input.price, gstFree: !!input.gstFree, tier, buckets };
  if (input.id) await db.plan.update({ where: { id: input.id }, data });
  else await db.plan.create({ data });
  await audit(input.id ? "Plan updated" : "Plan created", `${college.name} · ${name} · ₹${input.price}${input.gstFree ? " (no GST)" : ""}`, st.id);
  return { ok: true as const };
}

export async function togglePlan(planId: string) {
  const st = await requireStaff(3);
  const p = await db.plan.findUniqueOrThrow({ where: { id: planId } });
  await db.plan.update({ where: { id: planId }, data: { active: !p.active } });
  await audit("Plan " + (p.active ? "disabled" : "enabled"), p.name, st.id);
  return { ok: true as const, active: !p.active };
}

/* ----- Rates & GST (Admin+) ----- */
export async function saveRates(rates: Record<string, { label: string; items: [string, number][] }>, gstPct: number, gstEnabled?: boolean) {
  const st = await requireStaff(3);
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const settings = { ...(cfg.settings as Record<string, unknown>), ...(gstEnabled === undefined ? {} : { gstEnabled }) };
  await db.appConfig.update({ where: { id: "main" }, data: { rates: rates as object, gstPct, settings } });
  await audit("Rates updated", `GST ${gstPct}%${gstEnabled === false ? " (GST billing OFF)" : ""}`, st.id);
  return { ok: true as const };
}

/* ----- Payment & bank details (Admin+) ----- */
export async function savePaymentConfig(payment: { upiId: string; payeeName: string; bankName: string; accountName: string; accountNo: string; ifsc: string; gatewayKey: string }) {
  const st = await requireStaff(3);
  await db.appConfig.update({ where: { id: "main" }, data: { payment } });
  await audit("Payment details updated", payment.upiId, st.id);
  return { ok: true as const };
}

/* ----- Settings (report email etc., Admin+) ----- */
export async function saveSettings(settings: Record<string, unknown>) {
  const st = await requireStaff(3);
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const merged = { ...(cfg.settings as Record<string, unknown>), ...settings };
  await db.appConfig.update({ where: { id: "main" }, data: { settings: JSON.parse(JSON.stringify(merged)) } });
  await audit("Settings updated", Object.keys(settings).join(", "), st.id);
  return { ok: true as const };
}

/* ----- Colleges + per-college feature flags ----- */
export async function toggleFeature(collegeId: string, key: string) {
  const st = await requireStaff(2); // Manager+ toggle features
  const c = await db.college.findUniqueOrThrow({ where: { id: collegeId } });
  /* Flip the EFFECTIVE value, not the stored one. When a key was absent the
     old line wrote `false` regardless of what the admin saw, so the first
     click on a flag defaulting to on appeared to do nothing — the switch was
     already drawn as on, and turning it "off" produced the same screen. */
  const features = { ...(c.features as Record<string, boolean>) };
  features[key] = !featureOn(c.features, key as FeatureKey);
  await db.college.update({ where: { id: collegeId }, data: { features } });
  await audit("Feature toggle", `${c.name} · ${key} → ${features[key] ? "on" : "off"}`, st.id);
  publish([`orders:${collegeId}`], { type: "college.updated", payload: { collegeId } });
  return { ok: true as const, on: features[key] };
}

/* New colleges are stamped with the full documented default set. The old
   literal here omitted svc_washfold, so every campus added through the UI
   launched without Wash & Fold — the service Bronze is built on. */
const DEFAULT_FEATURES = { ...FEATURE_DEFAULTS };

export async function saveCollege(input: { id?: string; name: string; address: string; closedWeekday?: number | null }) {
  const st = await requireStaff(4); // Owner only add/edit
  const name = input.name.trim();
  if (!name) return { ok: false as const, error: "Name required" };
  const closedWeekday = input.closedWeekday === undefined || input.closedWeekday === null ? null : Number(input.closedWeekday);
  if (input.id) {
    await db.college.update({ where: { id: input.id }, data: { name, address: input.address.trim(), closedWeekday } });
    await audit("College updated", name, st.id);
  } else {
    await db.college.create({ data: { name, address: input.address.trim(), closedWeekday, features: DEFAULT_FEATURES } });
    await audit("College added", name, st.id);
  }
  return { ok: true as const };
}

/**
 * Remove a campus, or bring one back.
 *
 * Deactivation, not deletion — students, orders and payments still point at
 * it, and a hard delete would either fail on those references or orphan them.
 *
 * `active` was previously a ONE-WAY DOOR. Every screen listed only active
 * colleges, including the admin screen that owns this action, so a removed
 * campus disappeared from the app entirely and nothing anywhere set the flag
 * back. Its students then showed a campus of "-" in every list while their
 * own detail page still named it, because that page loads the college
 * directly. Restoring is the missing half.
 */
export async function setCollegeActive(collegeId: string, active: boolean) {
  const st = await requireStaff(4); // Owner only
  const c = await db.college.findUnique({ where: { id: collegeId } });
  if (!c) return { ok: false as const, error: "Campus not found" };
  if (c.active === active) return { ok: true as const, active };

  if (!active) {
    // Never remove the last one, or there is nowhere to register a student.
    const count = await db.college.count({ where: { active: true } });
    if (count <= 1) return { ok: false as const, error: "Keep at least one campus" };
  }

  await db.college.update({ where: { id: collegeId }, data: { active } });
  await audit(active ? "College restored" : "College removed", c.name, st.id);
  return { ok: true as const, active };
}

/** Back-compat wrapper: the admin screen still calls this to remove. */
export async function deleteCollege(collegeId: string) {
  return setCollegeActive(collegeId, false);
}

/* ----- Staff management (Admin+) ----- */
export async function saveStaff(input: { id?: string; name: string; phone: string; role: number; collegeId: string | null; perms?: Record<string, boolean> }) {
  const st = await requireStaff(3);
  const phone = input.phone.replace(/\D/g, "").slice(-10);
  if (!input.name.trim() || phone.length !== 10) return { ok: false as const, error: "Name and a valid mobile are required" };
  if (input.role >= 4 && st.role < 4) return { ok: false as const, error: "Only the owner can grant Owner" };
  /* Only known tool keys survive, and only real booleans — the override map
     reaches every permission check, so a stray key must die at the door. */
  const perms = input.perms
    ? Object.fromEntries(Object.entries(input.perms).filter(([k, v]) => k in PERM_DEFS && typeof v === "boolean"))
    : undefined;
  if (input.id) {
    await db.staff.update({ where: { id: input.id }, data: { name: input.name.trim(), phone, role: input.role, collegeId: input.collegeId, ...(perms !== undefined ? { perms } : {}) } });
    const granted = perms ? Object.entries(perms).map(([k, v]) => `${v ? "+" : "-"}${k}`).join(" ") : "";
    await audit("Staff updated", `${input.name} (role ${input.role})${granted ? ` · tools ${granted}` : ""}`, st.id);
  rosterSoon();
  } else {
    await db.staff.create({ data: { name: input.name.trim(), phone, role: input.role, collegeId: input.collegeId } });
    await audit("Staff added", `${input.name} (role ${input.role})`, st.id);
  rosterSoon();
  }
  return { ok: true as const };
}

/**
 * Remove a staff login, or restore one.
 *
 * Deactivates rather than deletes — see the note on Staff.active. The account
 * stops being able to sign in, but the payslips, attendance and audit trail
 * naming them stay intact, which is the point of keeping records at all.
 *
 * The guards exist because every one of these is a way to lock the business
 * out of its own admin panel, and none of them is recoverable from inside the
 * app once it has happened.
 */
export async function setStaffActive(staffId: string, active: boolean) {
  const st = await requireStaff(3); // Admin+
  const target = await db.staff.findUnique({ where: { id: staffId } });
  if (!target) return { ok: false as const, error: "Staff member not found" };
  if (target.active === active) return { ok: true as const, active };

  if (!active) {
    // You cannot remove yourself: one misclick would end your own session.
    if (target.id === st.id) return { ok: false as const, error: "You can't remove your own login" };
    // Only an Owner may remove an Owner — otherwise an Admin can demote the top.
    if (target.role >= 4 && st.role < 4) return { ok: false as const, error: "Only the owner can remove an owner" };
    // Never remove the last active Owner, or nobody can grant Owner again.
    if (target.role >= 4) {
      const owners = await db.staff.count({ where: { role: { gte: 4 }, active: true } });
      if (owners <= 1) return { ok: false as const, error: "This is the last owner — promote someone else first" };
    }
  }

  await db.staff.update({
    where: { id: staffId },
    // Bump the epoch so a signed-in device loses access immediately rather
    // than at token expiry. requireStaff also checks `active` every request.
    data: { active, sessionEpoch: { increment: 1 } },
  });
  await audit(active ? "Staff restored" : "Staff removed", `${target.name} · ${target.phone}`, st.id);
  rosterSoon();
  return { ok: true as const, active };
}

/* ----- Expenses (Manager+), with optional receipt upload key ----- */
export async function submitExpense(input: { category: string; amount: number; note: string; method: "cash" | "upi"; receiptKey?: string | null; receiptMime?: string | null }) {
  const st = await requireStaff(2);
  const amount = Math.floor(input.amount);
  if (!amount || amount <= 0) return { ok: false as const, error: "Enter a valid amount" };
  await db.expense.create({
    data: { category: input.category, amount, note: input.note.trim() || null, method: input.method, by: st.id, collegeId: st.collegeId || "", receiptKey: input.receiptKey || null, receiptMime: input.receiptMime || null },
  });
  await audit("Expense", `${input.category} ₹${amount} (${input.method})${input.note ? " — " + input.note : ""}${input.receiptKey ? " · invoice attached" : ""}`, st.id);
  return { ok: true as const };
}

/* ----- Payroll (Admin+): numbered payslip + optional auto Salaries expense ----- */
export async function createPayslip(input: { staffId: string; month: string; basic: number; allowances: number; deductions: number; postExpense: boolean }) {
  const st = await requireStaff(3);
  const net = Math.round(input.basic + input.allowances - input.deductions);
  if (net < 0) return { ok: false as const, error: "Net pay cannot be negative" };
  const target = await db.staff.findUniqueOrThrow({ where: { id: input.staffId } });
  const ym = input.month.replace(/\D/g, ""); // YYYYMM

  const slip = await db.$transaction(async (tx) => {
    const seq = await tx.fySequence.upsert({
      where: { kind_fyTag: { kind: "payslip", fyTag: ym } },
      create: { kind: "payslip", fyTag: ym, value: 1 },
      update: { value: { increment: 1 } },
    });
    const number = `PS-${ym}-${String(seq.value).padStart(3, "0")}`;
    let expenseId: string | null = null;
    if (input.postExpense) {
      const ex = await tx.expense.create({
        data: { category: "Salaries", amount: net, note: `Payslip ${number} · ${target.name}`, method: "upi", by: st.id, collegeId: target.collegeId || st.collegeId || "" },
      });
      expenseId = ex.id;
    }
    return tx.payslip.create({
      data: { number, staffId: input.staffId, month: input.month, basic: input.basic, allowances: input.allowances, deductions: input.deductions, net, expenseId },
    });
  });

  await audit("Payslip", `${slip.number} · ${target.name} · net ₹${net}${input.postExpense ? " · posted to Salaries" : ""}`, st.id);
  return { ok: true as const, number: slip.number };
}
