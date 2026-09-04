"use server";
/* BVRIT self-registration via WhatsApp (Oct 2026).

   Unlike St Mary's (staff-only counter registration), BVRIT students pay per-use
   and self-register here with a phone verification. The flow reuses the WhatsApp
   sign-in mechanism but creates a new account instead of signing into an existing
   one: a code is sent in a message, the webhook verifies the phone, and the claim
   completes registration and mints a session in one step.

   The student provides their NAME on the web page before sending the WhatsApp
   message, so the account creation has everything needed to complete.
   Phone is verified by Meta's webhook payload. */
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "../db";
import { createSession } from "../auth";
import { rateLimit, requestIp } from "../rate-limit";
import { notifyOwner } from "../mail";
import { audit } from "../notify";

const TTL_MS = 5 * 60_000;                    // same as login flow
const CLAIM_COOKIE = "ff_wa_register_claim"; // distinct from login cookie

/** Unambiguous alphabet: no O/0, I/1, S/5 — same as login. */
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";
function newCode() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** The business number students message, digits only, country code included. */
function businessNumber(): string | null {
  const n = (process.env.WHATSAPP_BUSINESS_NUMBER || "").replace(/\D/g, "");
  return n.length >= 10 ? n : null;
}

/**
 * Begin a registration. Student provides name and phone on the page; this
 * generates a code for them to send via WhatsApp to verify the phone.
 *
 * Returns the deep link to open WhatsApp with the code already typed.
 */
export async function startWhatsAppRegister(input: { name: string; collegeId: string }) {
  const number = businessNumber();
  if (!number) return { ok: false as const, error: "WhatsApp registration isn't switched on yet." };

  const name = input.name.trim();
  if (name.length < 2) return { ok: false as const, error: "Enter your name" };

  const college = await db.college.findUnique({ where: { id: input.collegeId } });
  if (!college || !college.active) return { ok: false as const, error: "Campus not found" };

  /* Rate-limit the flow the same way login does: per IP, same cap. */
  const ip = await requestIp();
  if (ip !== "unknown") {
    const lim = await rateLimit(`wa:register:${ip}`, 10, 3600);
    if (!lim.allowed) {
      return { ok: false as const, error: `Too many attempts from this device. Try again in ${Math.ceil(lim.retryAfterSec / 60)} minutes.` };
    }
  }

  const code = newCode();
  const claimSecret = crypto.randomBytes(32).toString("base64url");

  /* collegeId is stored HERE, server-side, at the moment the attempt starts —
     never trusted from a later client-supplied parameter. Otherwise a client
     could claim a phone-verified registration under a different college than
     the one it actually started with, no server check would catch it. */
  await db.waVerify.create({
    data: {
      code,
      claimHash: sha(claimSecret),
      mode: "register",
      collegeId: college.id,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });

  const jar = await cookies();
  jar.set(CLAIM_COOKIE, claimSecret, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.ceil(TTL_MS / 1000),
  });

  const text = `New student registration — ${college.name}: ${code}`;
  return {
    ok: true as const,
    code,
    link: `https://wa.me/${number}?text=${encodeURIComponent(text)}`,
    expiresInSec: Math.floor(TTL_MS / 1000),
  };
}

/**
 * Poll for registration completion and create the account.
 *
 * Returns "pending" until the webhook has seen the message. The session and
 * student account are created HERE, not in the webhook: the webhook proves
 * who sent the message, but only this request carries the cookie proving it
 * is the same browser that started the attempt. Account creation must be
 * atomic with session creation so either both happens or neither does.
 */
export async function checkWhatsAppRegister(code: string, studentName: string) {
  const row = await db.waVerify.findUnique({ where: { code } });
  if (!row) return { ok: false as const, status: "unknown" as const, error: "That registration has expired — start again." };

  if (row.status === "claimed") return { ok: false as const, status: "claimed" as const, error: "That registration was already used — start again." };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false as const, status: "expired" as const, error: "That registration expired — start again." };
  if (row.status === "failed") return { ok: false as const, status: "failed" as const, error: row.reason || "We couldn't verify that number." };
  if (row.status !== "verified" || !row.phone) return { ok: true as const, status: "pending" as const };

  /* collegeId is read from the row created at startWhatsAppRegister — never
     from a client-supplied parameter — so which college this registration is
     for was fixed the moment the attempt began and can't be changed later. */
  const college = row.collegeId ? await db.college.findUnique({ where: { id: row.collegeId } }) : null;
  if (!college) return { ok: false as const, status: "failed" as const, error: "Campus configuration error. Please try again." };

  /* The claim cookie proves this browser — same as login. */
  const jar = await cookies();
  const secret = jar.get(CLAIM_COOKIE)?.value || "";
  const a = Buffer.from(sha(secret), "utf8");
  const b = Buffer.from(row.claimHash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false as const, status: "wrong-device" as const, error: "Finish registering on the device where you started." };
  }

  /* Mark claimed BEFORE creating the account, same pattern as login. */
  const won = await db.waVerify.updateMany({
    where: { id: row.id, status: "verified" },
    data: { status: "claimed" },
  });
  if (won.count !== 1) return { ok: false as const, status: "claimed" as const, error: "That registration was already used — start again." };

  /* Now create the student account and issue their customer ID in one
     transaction, so if either fails the whole thing rolls back and the
     WaVerify remains unclaimed for retry. */
  let student;
  let bagCode;
  try {
    const result = await db.$transaction(async (tx) => {
      /* Generate a permanent 6-digit internal ID, same as counter registration. */
      let id = "";
      for (let i = 0; i < 20; i++) {
        id = String(Math.floor(100000 + Math.random() * 900000));
        if (!(await tx.student.findUnique({ where: { id } }))) break;
      }

      /* Create the student in the specified college with kind="student". */
      const stu = await tx.student.create({
        data: {
          id,
          phone: row.phone || "",  // phone is guaranteed by webhook
          name: studentName.trim(),
          collegeId: college!.id,  // college is guaranteed by the check above
          kind: "student",
        },
      });

      /* Issue a BVRIT (V series) bag code as their customer ID. */
      const { allocateBagCode } = await import("../bagcode");
      const code = await allocateBagCode(tx, "bvrit");

      /* Create the physical bag record with the allocated code. Self-issued
         by "self-registration" as the issuing staff (kept in audit log). */
      await tx.bag.create({
        data: {
          code,
          studentId: stu.id,
          tier: null,
          complimentary: true, // first bag is free
          issuedBy: "self-registration",
          status: "active",
        },
      });

      return { stu, code };
    });
    student = result.stu;
    bagCode = result.code;
  } catch (e) {
    console.error("[wa-register] account creation failed", e);
    /* The claim above marked this row "claimed" BEFORE the account-creation
       transaction ran — so a failure here (e.g. the phone already belongs
       to another student, a realistic case for someone registering twice)
       left the row permanently claimed with no route back to "verified".
       The comment above once claimed this was safe to retry; it wasn't.
       Revert the claim so the student can actually try again instead of
       being silently locked out of self-registration for this code. */
    await db.waVerify.updateMany({ where: { id: row.id, status: "claimed" }, data: { status: "verified" } });
    return { ok: false as const, status: "failed" as const, error: "Account creation failed. Please try again or visit the counter." };
  }

  /* Create the session to sign them in immediately. */
  await createSession({ mode: "customer", studentId: student.id, epoch: student.sessionEpoch });

  /* Audit log the self-registration. */
  await audit(
    "Student self-registered",
    `${student.name} · +91 ${row.phone} · BVRIT (WhatsApp) · ID ${student.id} · Code ${bagCode}`,
    "self-registration",
  ).catch(() => {});

  /* Notify the owner of the new registration. */
  void notifyOwner("New BVRIT registration", `${student.name} (+91 ${row.phone}) self-registered via WhatsApp — ID ${student.id}, bag code ${bagCode}.`);

  /* Send a WhatsApp confirmation to the new student. */
  const { sendWhatsApp } = await import("../notify");
  void sendWhatsApp(row.phone, `Welcome to FabricFold! Your ID is ${bagCode}. Show this at pickup.`).catch(() => {});

  jar.delete(CLAIM_COOKIE);
  return { ok: true as const, status: "registered" as const, studentId: student.id };
}
