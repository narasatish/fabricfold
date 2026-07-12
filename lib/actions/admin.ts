"use server";
/* Admin: rates & GST, plan, payment details, colleges + feature flags, staff,
   expenses (Manager+), payroll (Admin+). All sensitive edits audit-logged. */
import { db } from "../db";
import { requireStaff } from "../auth";
import { audit } from "../notify";
import { publish } from "../realtime";

/* ----- Register a student at the counter (any staff) ----- */
export async function registerStudent(input: { name: string; phone: string; collegeId: string }) {
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
  const stu = await db.student.create({ data: { id, phone, name, collegeId: college.id } });
  await audit("Student registered", `${name} · +91 ${phone} · ${college.name}`, st.id);
  return { ok: true as const, id: stu.id };
}

/* ----- Rates & GST (Admin+) ----- */
export async function saveRates(rates: Record<string, { label: string; items: [string, number][] }>, gstPct: number) {
  const st = await requireStaff(3);
  await db.appConfig.update({ where: { id: "main" }, data: { rates: rates as object, gstPct } });
  await audit("Rates updated", `GST ${gstPct}%`, st.id);
  return { ok: true as const };
}

/* ----- Plan (Admin+) ----- */
export async function savePlan(plan: { price: number; cycles: number; kgPerCycle: number }) {
  const st = await requireStaff(3);
  await db.appConfig.update({ where: { id: "main" }, data: { plan } });
  await audit("Plan updated", `₹${plan.price} · ${plan.cycles} cycles · ${plan.kgPerCycle}kg`, st.id);
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
  const features = { ...(c.features as Record<string, boolean>) };
  features[key] = features[key] === false ? true : false;
  await db.college.update({ where: { id: collegeId }, data: { features } });
  await audit("Feature toggle", `${c.name} · ${key} → ${features[key] ? "on" : "off"}`, st.id);
  publish([`orders:${collegeId}`], { type: "college.updated", payload: { collegeId } });
  return { ok: true as const, on: features[key] };
}

const DEFAULT_FEATURES = { svc_wash: true, svc_iron: true, svc_dryclean: true, subscriptions: true, credits: true, express: false, chat: true };

export async function saveCollege(input: { id?: string; name: string; address: string }) {
  const st = await requireStaff(4); // Owner only add/edit
  const name = input.name.trim();
  if (!name) return { ok: false as const, error: "Name required" };
  if (input.id) {
    await db.college.update({ where: { id: input.id }, data: { name, address: input.address.trim() } });
    await audit("College updated", name, st.id);
  } else {
    await db.college.create({ data: { name, address: input.address.trim(), features: DEFAULT_FEATURES } });
    await audit("College added", name, st.id);
  }
  return { ok: true as const };
}

export async function deleteCollege(collegeId: string) {
  const st = await requireStaff(4); // Owner only
  const count = await db.college.count({ where: { active: true } });
  if (count <= 1) return { ok: false as const, error: "Keep at least one college" };
  const c = await db.college.update({ where: { id: collegeId }, data: { active: false } });
  await audit("College removed", c.name, st.id);
  return { ok: true as const };
}

/* ----- Staff management (Admin+) ----- */
export async function saveStaff(input: { id?: string; name: string; phone: string; role: number; collegeId: string | null }) {
  const st = await requireStaff(3);
  const phone = input.phone.replace(/\D/g, "").slice(-10);
  if (!input.name.trim() || phone.length !== 10) return { ok: false as const, error: "Name and a valid mobile are required" };
  if (input.role >= 4 && st.role < 4) return { ok: false as const, error: "Only the owner can grant Owner" };
  if (input.id) {
    await db.staff.update({ where: { id: input.id }, data: { name: input.name.trim(), phone, role: input.role, collegeId: input.collegeId } });
    await audit("Staff updated", `${input.name} (role ${input.role})`, st.id);
  } else {
    await db.staff.create({ data: { name: input.name.trim(), phone, role: input.role, collegeId: input.collegeId } });
    await audit("Staff added", `${input.name} (role ${input.role})`, st.id);
  }
  return { ok: true as const };
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
