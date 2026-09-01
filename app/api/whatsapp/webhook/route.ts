/* WhatsApp inbound webhook — the mechanism behind "Continue with WhatsApp".

   Meta blocks AUTHENTICATION templates until a WABA has messaged 2,000 unique
   users, which a new campus account will never reach. That gate applies to
   BUSINESS-initiated messages. It does not apply when the student messages us
   first — so verification runs the other way round: the student sends a code
   to our number, and this endpoint learns their verified phone number from the
   delivery Meta makes to us. No template, no gate, no DLT, nothing to approve.

   Two methods, two different jobs:
     GET  — Meta's subscription handshake, once, when you save the callback URL
     POST — every inbound message and status update, forever after

   This endpoint only RECORDS a verification. It never creates a session: the
   webhook proves who sent the message, but not which browser is waiting for
   it. That second half needs the claim cookie, so it lives in
   lib/actions/wa-login.ts where the request carries one. */
import crypto from "node:crypto";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Subscription handshake. Meta calls this once with the token you typed into
 * the dashboard; echoing the challenge back is what registers the URL.
 *
 * The token is compared in constant time. It is low-value on its own, but a
 * timing oracle on a public endpoint is free to avoid.
 */
export async function GET(req: Request) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) return new Response("webhook not configured", { status: 503 });

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";

  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  const ok = mode === "subscribe" && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return new Response("forbidden", { status: 403 });

  // Must be the bare challenge as text/plain — JSON or a wrapper fails the check.
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/**
 * Inbound deliveries.
 *
 * Signature verification is not optional here. This URL is public and its
 * payload will eventually be trusted to say "this phone number is verified" —
 * without the check, anyone who learns the URL could POST that claim and sign
 * in as any student. Meta signs every body with the app secret.
 */
export async function POST(req: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return new Response("webhook not configured", { status: 503 });

  const body = await req.text();
  const header = req.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  /* timingSafeEqual THROWS on a length mismatch, so an absent or malformed
     header would 500 rather than 401 — the same trap the Razorpay webhook
     documents. Compare lengths first, then in constant time. */
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: WaPayload;
  try {
    payload = JSON.parse(body) as WaPayload;
  } catch {
    // Malformed JSON is not worth a retry storm; accept and drop.
    return Response.json({ ok: true });
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      /* Meta posts delivery receipts (sent/delivered/read) to this same URL.
         They are not messages and must not be treated as one. */
      if (!value?.messages?.length) continue;

      for (const msg of value.messages) {
        const from = msg.from;                      // sender's number, digits, country code included
        const text = msg.text?.body?.trim() ?? "";
        if (!from) continue;
        console.log(`[wa-inbound] from=${from} type=${msg.type} text=${JSON.stringify(text.slice(0, 80))}`);
        await resolveSignIn(from, text);
      }
    }
  }

  /* Always 200, even for payloads we ignore. Meta retries non-2xx with
     backoff and eventually disables a webhook that keeps failing, so an
     unrecognised shape must not look like an outage. */
  return Response.json({ ok: true });
}

/**
 * Match an inbound message to a pending sign-in.
 *
 * Never throws: an exception here becomes a non-2xx, which makes Meta retry
 * and eventually disable the webhook — losing every future sign-in over one
 * bad message.
 */
async function resolveSignIn(from: string, text: string) {
  try {
    /* The code sits inside a sentence the student may have edited, so it is
       extracted rather than parsed. Case-insensitive because some keyboards
       auto-capitalise, and the alphabet has no ambiguous characters. */
    const m = text.toUpperCase().match(/\b[ABCDEFGHJKLMNPQRTUVWXYZ2346789]{8}\b/);
    if (!m) return;

    const row = await db.waVerify.findUnique({ where: { code: m[0] } });
    if (!row || row.status !== "pending") return;          // already handled, or not ours
    if (row.expiresAt.getTime() < Date.now()) return;      // let it expire quietly

    /* Meta gives the number with country code and no plus. Accounts are
       stored as the last 10 digits, the same normalisation used everywhere
       else a phone is compared. */
    const phone = from.replace(/\D/g, "").slice(-10);

    /* The attempt's MODE decides which table answers. A staff attempt from a
       number that is only a student FAILS — same wording as OTP staff login,
       and deliberately no hint about which numbers are staff. */
    let accountId: string | null = null;
    let failReason: string;
    if (row.mode === "staff") {
      const st = await db.staff.findUnique({ where: { phone } });
      accountId = st && st.active ? st.id : null;
      failReason = "This number is not registered as staff.";
    } else {
      const stu = await db.student.findUnique({ where: { phone } });
      accountId = stu?.id ?? null;
      failReason = "This WhatsApp number isn't registered yet — please visit the counter to be registered.";
    }

    /* No account is a FAILURE, recorded with a reason, not silence — the
       person is staring at a spinner. updateMany, not update: it takes a
       non-unique filter, so `status` stays in the WHERE and a duplicate
       delivery — Meta retries — cannot overwrite an already-resolved row. */
    await db.waVerify.updateMany({
      where: { id: row.id, status: "pending" },
      data: accountId
        ? { status: "verified", phone, studentId: accountId }
        : { status: "failed", phone, reason: failReason },
    });
  } catch (e) {
    console.error("[wa-inbound] sign-in match failed", e);
  }
}

type WaPayload = {
  entry?: {
    changes?: {
      value?: {
        messages?: { from?: string; type?: string; text?: { body?: string } }[];
        statuses?: unknown[];
      };
    }[];
  }[];
};
