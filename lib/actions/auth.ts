"use server";
/* Phone-OTP auth. DEV_OTP fallback prints the code to the server console;
   swap `sendSms` for Twilio/MSG91 behind the same interface in production. */
import crypto from "node:crypto";
import { db } from "../db";
import { createSession, clearSession, requireStudent } from "../auth";
import { notifyOwner } from "../mail";

const OTP_TTL = 5 * 60_000;

/* Deliver the login code by SMS. Providers, first configured one wins:
   1. SMS-Gate (free) — the "SMS Gateway" Android app (sms-gate.app) running on
      the owner's spare phone; OTPs go out from its SIM via the app's cloud API.
      Env: SMSGATE_LOGIN + SMSGATE_PASSWORD (shown inside the app).
   2. MSG91 (paid, DLT) — env: MSG91_AUTHKEY + MSG91_TEMPLATE_ID.
   3. Console fallback (dev / pre-SMS soft launch). */
async function sendSms(phone: string, code: string) {
  const text = `Your FabricFold login OTP is ${code}. It expires in 5 minutes.`;

  const sgLogin = process.env.SMSGATE_LOGIN, sgPass = process.env.SMSGATE_PASSWORD;
  if (sgLogin && sgPass) {
    const res = await fetch("https://api.sms-gate.app/3rdparty/v1/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${sgLogin}:${sgPass}`).toString("base64"),
      },
      body: JSON.stringify({ message: text, phoneNumbers: ["+91" + phone] }),
    });
    if (!res.ok) {
      console.error("SMS-Gate send failed", res.status, await res.text().catch(() => ""));
      throw new Error("Couldn't send the OTP — please try again in a moment");
    }
    return;
  }

  const authKey = process.env.MSG91_AUTHKEY, templateId = process.env.MSG91_TEMPLATE_ID;
  if (authKey && templateId) {
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { "Content-Type": "application/json", authkey: authKey },
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
    return;
  }

  console.log(`[SMS -> ${phone}] ${text}`);
}

/* Numbers allowed to use the fixed DEV_OTP code. Comma-separated, last 10
   digits, e.g. TEST_PHONES="8019121966,7799661888". */
function testPhones(): string[] {
  return (process.env.TEST_PHONES || "")
    .split(",")
    .map((p) => p.replace(/\D/g, "").slice(-10))
    .filter((p) => p.length === 10);
}

function randomCode() {
  // crypto RNG — Math.random() is predictable and must never mint a login code.
  return String(100000 + (crypto.randomInt(0, 900000)));
}

/* A fixed code is a master key for EVERY account, so it is only ever honoured
   when the number is explicitly allowlisted. Outside production a bare DEV_OTP
   still works for convenience; in production it is ignored entirely unless the
   number is in TEST_PHONES. */
function genCode(phone: string) {
  const dev = process.env.DEV_OTP;
  if (!dev) return randomCode();
  const allowed = testPhones();
  if (allowed.includes(phone)) return dev;
  if (process.env.NODE_ENV !== "production" && allowed.length === 0) return dev;
  return randomCode();
}

export async function requestOtp(phone: string, mode: "customer" | "staff") {
  phone = phone.replace(/\D/g, "").slice(-10);
  if (phone.length !== 10) return { ok: false as const, error: "Enter a valid 10-digit mobile number" };

  if (mode === "staff") {
    const st = await db.staff.findUnique({ where: { phone } });
    if (!st) return { ok: false as const, error: "This number is not registered as staff" };
  }

  // Cooldown: at most one OTP per 30 seconds per number (blocks SMS-bombing / spam).
  const existing = await db.otp.findFirst({ where: { phone, purpose: "login", usedAt: null } });
  if (existing && existing.expiresAt.getTime() - OTP_TTL > Date.now() - 30_000) {
    return { ok: false as const, error: "OTP just sent — wait 30 seconds before requesting again" };
  }

  const code = genCode(phone);
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
  if (!otp) return { ok: false as const, error: "Incorrect or expired OTP" };

  // Brute-force protection: a wrong code burns one of 5 attempts; the 5th kills the OTP.
  if (otp.attempts >= 5) {
    await db.otp.delete({ where: { id: otp.id } }).catch(() => {});
    return { ok: false as const, error: "Too many wrong attempts — request a new OTP" };
  }
  if (otp.code !== code.trim()) {
    const updated = await db.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    if (updated.attempts >= 5) {
      await db.otp.delete({ where: { id: otp.id } }).catch(() => {});
      return { ok: false as const, error: "Too many wrong attempts — request a new OTP" };
    }
    return { ok: false as const, error: "Incorrect or expired OTP" };
  }

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
    const college = await db.college.findUnique({ where: { id: reg.collegeId } });
    void notifyOwner("New student registered", `${stu.name} (+91 ${phone}) signed up at ${college?.name || "?"} — ID ${stu.id}.`);
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
