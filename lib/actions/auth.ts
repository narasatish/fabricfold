"use server";
/* Phone-OTP auth. DEV_OTP fallback prints the code to the server console;
   swap `sendSms` for Twilio/MSG91 behind the same interface in production. */
import { db } from "../db";
import { createSession, clearSession, requireStudent } from "../auth";

const OTP_TTL = 5 * 60_000;

/* Deliver the login code by SMS.
   - If MSG91 keys are set → send a real SMS via MSG91's Flow API.
   - Otherwise → fall back to the server console (dev / pre-SMS soft launch). */
async function sendSms(phone: string, code: string) {
  const authKey = process.env.MSG91_AUTHKEY;
  const templateId = process.env.MSG91_TEMPLATE_ID;
  if (!authKey || !templateId) {
    console.log(`[SMS -> ${phone}] Your FabricFold login OTP is ${code}`);
    return;
  }
  const res = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: { "Content-Type": "application/json", authkey: authKey },
    // The template's variable name must match one of these keys — adjust to your
    // DLT-approved template (commonly ##OTP##). We send several aliases to be safe.
    body: JSON.stringify({
      template_id: templateId,
      ...(process.env.MSG91_SENDER_ID ? { sender: process.env.MSG91_SENDER_ID } : {}),
      recipients: [{ mobiles: "91" + phone, OTP: code, otp: code, var1: code, code }],
    }),
  });
  if (!res.ok) {
    console.error("MSG91 send failed", res.status, await res.text().catch(() => ""));
    throw new Error("Couldn't send the OTP — please try again in a moment");
  }
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
  await sendSms(phone, code);
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
