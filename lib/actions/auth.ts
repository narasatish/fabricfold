"use server";
/* Phone-OTP auth. DEV_OTP fallback prints the code to the server console;
   swap `sendSms` for Twilio/MSG91 behind the same interface in production. */
import { db } from "../db";
import { createSession, clearSession, requireStudent } from "../auth";

const OTP_TTL = 5 * 60_000;

async function sendSms(phone: string, text: string) {
  // MessageProvider interface — dev: log to console.
  console.log(`[SMS -> ${phone}] ${text}`);
}

function genCode() {
  if (process.env.DEV_OTP) return process.env.DEV_OTP;
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function requestOtp(phone: string, mode: "customer" | "staff") {
  phone = phone.replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return { ok: false as const, error: "Enter a valid 10-digit mobile number" };

  if (mode === "staff") {
    const st = await db.staff.findUnique({ where: { phone } });
    if (!st) return { ok: false as const, error: "This number is not registered as staff" };
  }
  const code = genCode();
  await db.otp.deleteMany({ where: { phone, purpose: "login" } });
  await db.otp.create({ data: { phone, purpose: "login", code, expiresAt: new Date(Date.now() + OTP_TTL) } });
  await sendSms(phone, `Your FabricFold login OTP is ${code}`);
  return { ok: true as const };
}

export async function verifyOtp(
  phone: string,
  code: string,
  mode: "customer" | "staff",
  reg?: { name: string; collegeId: string },
) {
  phone = phone.replace(/\D/g, "").slice(-10);
  const otp = await db.otp.findFirst({
    where: { phone, purpose: "login", usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "desc" },
  });
  if (!otp || otp.code !== code.trim()) return { ok: false as const, error: "Incorrect or expired OTP" };

  if (mode === "staff") {
    const st = await db.staff.findUnique({ where: { phone } });
    if (!st) return { ok: false as const, error: "Not registered as staff" };
    await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    await createSession({ mode: "staff", staffId: st.id, role: st.role });
    return { ok: true as const };
  }

  let stu = await db.student.findUnique({ where: { phone } });
  if (!stu) {
    // Don't consume the OTP yet — the registration step re-submits the same code.
    if (!reg?.name || !reg?.collegeId) return { ok: false as const, error: "NEEDS_REGISTRATION" };
    // permanent random 6-digit FabricFold code, unique
    let id = "";
    for (let i = 0; i < 20; i++) {
      id = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await db.student.findUnique({ where: { id } }))) break;
    }
    stu = await db.student.create({ data: { id, phone, name: reg.name.trim(), collegeId: reg.collegeId } });
  }
  await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  await createSession({ mode: "customer", studentId: stu.id });
  return { ok: true as const };
}

export async function logout() {
  await clearSession();
  return { ok: true as const };
}

export async function listColleges() {
  return db.college.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

export async function updateName(name: string) {
  const stu = await requireStudent();
  name = name.trim();
  if (name.length < 2 || name.length > 60) return { ok: false as const, error: "Enter a valid name" };
  await db.student.update({ where: { id: stu.id }, data: { name } });
  return { ok: true as const };
}
