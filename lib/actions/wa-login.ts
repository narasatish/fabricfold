"use server";
/* "Continue with WhatsApp" — sign-in without an OTP.

   The student sends US a code instead of receiving one. Meta gates
   AUTHENTICATION templates behind 2,000 unique recipients, unreachable for a
   single campus, but that gate applies only to business-initiated messages.
   An inbound message needs no template, costs nothing, and Meta's webhook
   payload carries the sender's verified number — which is exactly what an OTP
   was proving in the first place.

   Two secrets, doing different jobs:
     code        travels through WhatsApp in clear text. It identifies the
                 attempt. Anyone can read it over the student's shoulder.
     claimSecret never leaves this browser (httpOnly cookie). It authorises
                 turning a verified attempt into a session.
   Both are required to sign in, so an onlooker who reads the code off a
   screen still cannot take the session. */
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "../db";
import { createSession } from "../auth";
import { rateLimit, requestIp } from "../rate-limit";

const TTL_MS = 5 * 60_000;      // matches the OTP window — long enough to switch apps, short enough to matter
const CLAIM_COOKIE = "ff_wa_claim";

/** Unambiguous alphabet: no O/0, I/1, S/5 — this gets read aloud and retyped. */
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
 * Begin a sign-in. Returns the deep link to open WhatsApp with the code
 * already typed, so the student's only action is to hit send.
 */
export async function startWhatsAppLogin() {
  const number = businessNumber();
  if (!number) return { ok: false as const, error: "WhatsApp sign-in isn't switched on yet — use your passcode, or ask at the counter." };

  /* Per-IP cap. Each attempt is a database row and a pending sign-in; without
     this, one script could fill the table and keep every code slot warm. */
  const ip = await requestIp();
  if (ip !== "unknown") {
    const lim = await rateLimit(`wa:start:${ip}`, 10, 3600);
    if (!lim.allowed) {
      return { ok: false as const, error: `Too many attempts from this device. Try again in ${Math.ceil(lim.retryAfterSec / 60)} minutes.` };
    }
  }

  const code = newCode();
  const claimSecret = crypto.randomBytes(32).toString("base64url");

  await db.waVerify.create({
    data: { code, claimHash: sha(claimSecret), expiresAt: new Date(Date.now() + TTL_MS) },
  });

  const jar = await cookies();
  jar.set(CLAIM_COOKIE, claimSecret, {
    httpOnly: true,                                 // page scripts can never read it
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.ceil(TTL_MS / 1000),
  });

  const text = `Sign me in to FabricFold: ${code}`;
  return {
    ok: true as const,
    code,
    // wa.me works on phone and desktop alike, and needs no app-specific handling
    link: `https://wa.me/${number}?text=${encodeURIComponent(text)}`,
    expiresInSec: Math.floor(TTL_MS / 1000),
  };
}

/**
 * Poll for the result, and sign in when it lands.
 *
 * Returns "pending" until the webhook has seen the message. The session is
 * created HERE rather than in the webhook: the webhook proves who sent the
 * message, but only this request carries the cookie proving it is the same
 * browser that started the attempt.
 */
export async function checkWhatsAppLogin(code: string) {
  const row = await db.waVerify.findUnique({ where: { code } });
  if (!row) return { ok: false as const, status: "unknown" as const, error: "That sign-in has expired — start again." };

  if (row.status === "claimed") return { ok: false as const, status: "claimed" as const, error: "That sign-in was already used — start again." };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false as const, status: "expired" as const, error: "That sign-in expired — start again." };
  if (row.status === "failed") return { ok: false as const, status: "failed" as const, error: row.reason || "We couldn't verify that number." };
  if (row.status !== "verified" || !row.studentId) return { ok: true as const, status: "pending" as const };

  /* The claim cookie is what makes this browser — rather than anyone who read
     the code — the one that gets the session. Compared in constant time, and
     against a hash, so neither timing nor a database dump gives it away. */
  const jar = await cookies();
  const secret = jar.get(CLAIM_COOKIE)?.value || "";
  const a = Buffer.from(sha(secret), "utf8");
  const b = Buffer.from(row.claimHash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false as const, status: "wrong-device" as const, error: "Finish signing in on the device where you started." };
  }

  const stu = await db.student.findUnique({ where: { id: row.studentId } });
  if (!stu) return { ok: false as const, status: "failed" as const, error: "That account no longer exists." };

  /* Mark claimed BEFORE issuing the session, and only from `verified`, so two
     simultaneous polls cannot both mint one. updateMany returns a count, which
     makes losing the race observable rather than silent. */
  const won = await db.waVerify.updateMany({
    where: { id: row.id, status: "verified" },
    data: { status: "claimed" },
  });
  if (won.count !== 1) return { ok: false as const, status: "claimed" as const, error: "That sign-in was already used — start again." };

  await createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });
  jar.delete(CLAIM_COOKIE);
  return { ok: true as const, status: "signed-in" as const };
}
