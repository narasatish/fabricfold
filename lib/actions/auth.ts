"use server";
/* Phone-OTP auth. DEV_OTP fallback prints the code to the server console;
   swap `sendSms` for Twilio/MSG91 behind the same interface in production. */
import crypto from "node:crypto";
import { db } from "../db";
import { createSession, clearSession, requireStudent } from "../auth";
import { rateLimit, requestIp } from "../rate-limit";
import {
  hashPasscode, verifyPasscode, passcodeProblem, lockoutMinutesLeft,
  MAX_PW_ATTEMPTS, LOCKOUT_MS,
} from "../password";

const OTP_TTL = 5 * 60_000;

/* Caps beyond the 30-second cooldown. A legitimate student needs two or three
   codes on a bad day; anything approaching these numbers is abuse. */
const OTP_MAX_PER_NUMBER_HOUR = 5;
const OTP_MAX_PER_IP_HOUR = 15; // a shared hostel wifi may carry several students

/* Deliver the login code by SMS. Providers, first configured one wins:
   1. SMS-Gate (free) — the "SMS Gateway" Android app (sms-gate.app) running on
      the owner's spare phone; OTPs go out from its SIM via the app's cloud API.
      Env: SMSGATE_LOGIN + SMSGATE_PASSWORD (shown inside the app).
   2. Twilio (testing) — env: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM.
   3. MSG91 (paid, DLT) — env: MSG91_AUTHKEY + MSG91_TEMPLATE_ID.
   4. Console fallback (dev / pre-SMS soft launch).

   Free-first is deliberate: SMS-Gate costs nothing and is tried before any
   paid provider, so wiring Twilio for testing can't quietly start billing
   every login once the free gateway is live. */
async function sendSms(phone: string, code: string) {
  const text = `Your FabricFold login OTP is ${code}. It expires in 5 minutes.`;

  // Dry run short-circuits BEFORE any provider, so nothing leaves the machine.
  if (process.env.SMS_DRY_RUN === "1") {
    console.log(`[SMS dry-run -> ${phone}] ${text}`);
    return;
  }

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

  /* Twilio — used for TESTING against arbitrary numbers before the free
     SMS-Gate phone is in place. Trial accounts can only send to numbers
     verified in the Twilio console, so a failure here is usually "recipient
     not verified", not a code fault. Indian delivery from a Twilio number also
     needs DLT registration, same as MSG91 — fine for testing, not for launch.
     Env: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM. */
  const twSid = process.env.TWILIO_ACCOUNT_SID, twTok = process.env.TWILIO_AUTH_TOKEN, twFrom = process.env.TWILIO_FROM;
  if (twSid && twTok && twFrom) {
    const body = new URLSearchParams({ To: "+91" + phone, From: twFrom, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${twSid}:${twTok}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Twilio send failed", res.status, detail);
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

/* Is any real SMS provider wired up? Console logging is not delivery.

   NOT exported: a "use server" module may only export async functions, and a
   plain export here invalidates every other export in the file — the same trap
   that broke the complaints module earlier today. */
function smsConfigured() {
  /* SMS_DRY_RUN=1 means "behave as though delivery works, but don't call out".
     Without it, tests covering code GENERATION couldn't run at all once
     requestOtp started refusing undeliverable numbers — and worse, their
     security assertions passed vacuously against an undefined code. It is also
     the honest way to exercise the flow on staging without spending messages. */
  if (process.env.SMS_DRY_RUN === "1") return true;
  return !!(
    (process.env.SMSGATE_LOGIN && process.env.SMSGATE_PASSWORD) ||
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) ||
    (process.env.MSG91_AUTHKEY && process.env.MSG91_TEMPLATE_ID)
  );
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

  /* Per-number and per-IP caps on top of that cooldown.

     The 30-second rule alone only slows one number down. Someone cycling
     through numbers could still make us send hundreds of texts — every one
     billed to us, and to strangers who never asked. The IP cap is the one that
     actually stops that; the hourly per-number cap stops a single victim being
     woken up all night. */
  const ip = await requestIp();
  const perNumber = await rateLimit(`otp:phone:${phone}`, OTP_MAX_PER_NUMBER_HOUR, 3600);
  if (!perNumber.allowed) {
    return {
      ok: false as const,
      error: `Too many codes requested for this number. Try again in ${Math.ceil(perNumber.retryAfterSec / 60)} minutes.`,
    };
  }
  if (ip !== "unknown") {
    const perIp = await rateLimit(`otp:ip:${ip}`, OTP_MAX_PER_IP_HOUR, 3600);
    if (!perIp.allowed) {
      return {
        ok: false as const,
        error: `Too many code requests from this device. Try again in ${Math.ceil(perIp.retryAfterSec / 60)} minutes.`,
      };
    }
  }

  /* Refuse rather than pretend.

     Without an SMS provider, sendSms() only console.logs — so a randomly
     generated code goes to a server log nobody reads while this returned
     success. The student then waits for a message that will never arrive and
     eventually types the fixed code, which only works for allowlisted numbers.
     That was the intermittent "incorrect OTP": it depended entirely on whether
     the number happened to be in TEST_PHONES. */
  const allowlisted = testPhones().includes(phone);
  const deliverable = smsConfigured() || allowlisted;
  if (!deliverable) {
    return {
      ok: false as const,
      error:
        "We can't text a code to this number yet — SMS isn't switched on. " +
        "Ask at the counter and staff will sign you in.",
    };
  }

  const code = genCode(phone);
  await db.otp.deleteMany({ where: { phone, purpose: "login" } });
  await db.otp.create({ data: { phone, purpose: "login", code, expiresAt: new Date(Date.now() + OTP_TTL) } });

  // A send failure must not look like a success either.
  if (smsConfigured()) {
    try {
      await sendSms(phone, code);
    } catch (e) {
      await db.otp.deleteMany({ where: { phone, purpose: "login" } });
      return { ok: false as const, error: (e as Error).message || "Couldn't send the OTP — please try again" };
    }
  } else {
    await sendSms(phone, code); // allowlisted + no provider: logs, code is the known test one
  }

  // `fixedCode` lets the sign-in screen say "use your test code" instead of
  // "check your messages" when no SMS actually went out.
  return { ok: true as const, fixedCode: !smsConfigured() && allowlisted };
}

export async function verifyOtp(
  phone: string,
  code: string,
  mode: "customer" | "staff",
  // registration is staff-only now (see registerStudent); this param is kept
  // only so old client bundles calling with a 4th arg don't hard-error.
  _reg?: { name: string; collegeId: string },
) {
  phone = phone.replace(/\D/g, "").slice(-10);
  const otp = await db.otp.findFirst({
    where: { phone, purpose: "login", usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "desc" },
  });

  /* "Incorrect or expired" hid three different problems and sent people round
     in circles retyping a code that could never work. Separate them, so the
     message says what to actually do. */
  if (!otp) {
    const stale = await db.otp.findFirst({ where: { phone, purpose: "login", usedAt: null } });
    if (stale) return { ok: false as const, error: "That code has expired — tap Resend to get a new one" };
    return { ok: false as const, error: "No code was requested for this number — tap Send OTP first" };
  }

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
    // remaining attempts stated plainly: a silent counter that suddenly locks
    // the account is worse than one you can see running down
    const left = 5 - updated.attempts;
    return { ok: false as const, error: `Incorrect code — ${left} attempt${left === 1 ? "" : "s"} left` };
  }

  if (mode === "staff") {
    const st = await db.staff.findUnique({ where: { phone } });
    if (!st) return { ok: false as const, error: "Not registered as staff" };
    await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    await createSession({ mode: "staff", staffId: st.id, role: st.role, epoch: st.sessionEpoch });
    return { ok: true as const };
  }

  // No self-registration: a student account can only be created by staff at
  // the counter (registerStudent, Admin>=1). An unrecognised number is turned
  // away here rather than allowed to create its own account.
  const stu = await db.student.findUnique({ where: { phone } });
  if (!stu) {
    return { ok: false as const, error: "This number isn't registered yet — please visit the counter to be registered." };
  }
  await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  await createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });
  return { ok: true as const };
}

/* ─────────────── Passcode: set, change, sign in ───────────────

   OTP stays the root of trust: it proves possession of the phone, which is the
   only thing we can actually verify. A passcode is a convenience on top —
   faster, and it works where the signal doesn't. So every path that CREATES or
   RESETS a passcode requires either a live session or a fresh OTP; a passcode
   can never be set by knowing only a phone number. */

/** Set or replace the passcode. Requires an already-signed-in student, which
    means they arrived either by OTP or by their existing passcode. */
export async function setPasscode(passcode: string) {
  const stu = await requireStudent();
  const problem = passcodeProblem(passcode);
  if (problem) return { ok: false as const, error: problem };

  const { hash, salt } = await hashPasscode(passcode.trim());
  await db.student.update({
    where: { id: stu.id },
    // clear any lockout: setting a new passcode is a deliberate reset
    data: { passwordHash: hash, passwordSalt: salt, passwordSetAt: new Date(), pwFailedAttempts: 0, pwLockedUntil: null },
  });
  return { ok: true as const };
}

/** Change it while signed in, proving the current one first. Without that
    check, an unattended phone is a permanent account takeover. */
export async function changePasscode(current: string, next: string) {
  const stu = await requireStudent();
  if (!stu.passwordHash) return { ok: false as const, error: "No passcode set yet — create one instead" };

  const okNow = await verifyPasscode((current || "").trim(), stu.passwordHash, stu.passwordSalt);
  if (!okNow) return { ok: false as const, error: "Current passcode is wrong" };

  const problem = passcodeProblem(next);
  if (problem) return { ok: false as const, error: problem };
  if ((next || "").trim() === (current || "").trim()) {
    return { ok: false as const, error: "New passcode must be different" };
  }

  const { hash, salt } = await hashPasscode(next.trim());
  await db.student.update({
    where: { id: stu.id },
    data: { passwordHash: hash, passwordSalt: salt, passwordSetAt: new Date(), pwFailedAttempts: 0, pwLockedUntil: null },
  });
  return { ok: true as const };
}

/** Does this number have a passcode? Lets the sign-in screen offer the right
    option without revealing whether the number is registered at all. */
export async function hasPasscode(phone: string) {
  const p = phone.replace(/\D/g, "").slice(-10);
  if (p.length !== 10) return { ok: true as const, hasPasscode: false };
  const stu = await db.student.findUnique({ where: { phone: p }, select: { passwordHash: true } });
  return { ok: true as const, hasPasscode: !!stu?.passwordHash };
}

/** Sign in with phone + passcode. Students only — staff stay OTP-only, since a
    staff account can move money and take payments. */
export async function loginWithPasscode(phone: string, passcode: string) {
  const p = phone.replace(/\D/g, "").slice(-10);
  if (p.length !== 10) return { ok: false as const, error: "Enter a valid 10-digit mobile number" };

  const stu = await db.student.findUnique({ where: { phone: p } });

  /* Deliberately identical wording whether the number is unknown or the
     passcode is wrong. Distinct messages would turn this into a directory of
     who is registered. */
  const generic = "Mobile number or passcode is incorrect";
  if (!stu || !stu.passwordHash) return { ok: false as const, error: generic };

  const lockedFor = lockoutMinutesLeft(stu.pwLockedUntil);
  if (lockedFor > 0) {
    return {
      ok: false as const,
      error: `Too many wrong tries — locked for ${lockedFor} more minute${lockedFor === 1 ? "" : "s"}. Use Sign in with OTP instead.`,
    };
  }

  const good = await verifyPasscode((passcode || "").trim(), stu.passwordHash, stu.passwordSalt);
  if (!good) {
    const attempts = stu.pwFailedAttempts + 1;
    const lock = attempts >= MAX_PW_ATTEMPTS;
    await db.student.update({
      where: { id: stu.id },
      data: {
        pwFailedAttempts: lock ? 0 : attempts, // reset the counter when the lock starts
        pwLockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : stu.pwLockedUntil,
      },
    });
    if (lock) {
      return {
        ok: false as const,
        error: `Too many wrong tries — locked for ${Math.round(LOCKOUT_MS / 60_000)} minutes. Use Sign in with OTP instead.`,
      };
    }
    const left = MAX_PW_ATTEMPTS - attempts;
    return { ok: false as const, error: `${generic} — ${left} attempt${left === 1 ? "" : "s"} left` };
  }

  if (stu.pwFailedAttempts || stu.pwLockedUntil) {
    await db.student.update({ where: { id: stu.id }, data: { pwFailedAttempts: 0, pwLockedUntil: null } });
  }
  await createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });
  return { ok: true as const };
}

/* Revoke every session for this account, including the one on a lost phone.
   Bumping the epoch invalidates all previously issued tokens at once — a JWT
   cannot be recalled any other way. */
export async function signOutEverywhere() {
  const stu = await requireStudent();
  await db.student.update({ where: { id: stu.id }, data: { sessionEpoch: { increment: 1 } } });
  await clearSession();
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
