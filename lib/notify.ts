import { db } from "./db";
import { publish } from "./realtime";
import { sendPushTo } from "./push";
import type { Prisma } from "./generated/prisma/client";

/* WhatsApp via Meta's WhatsApp Cloud API. Activates when WHATSAPP_TOKEN +
   WHATSAPP_PHONE_ID are set; silently skipped until then. Fire-and-forget —
   never blocks an order. */
const WA_API = "https://graph.facebook.com/v20.0";

/* A failed send used to only reach console.error, which nobody reviews on
   Vercel serverless — a sustained outage (rate-limit, expired token) meant
   students silently stopped getting "order ready" pings with no trace
   anywhere the owner would see, including the app's own error-digest cron.
   Record it too, best-effort — logging a failure must never itself throw.

   kind MUST be "client", not "server": notifyOwner() calls this chain on
   EVERY notification, including the ones cron-watchdog and error-digest
   send to alert the owner about OTHER errors. A "server"-kind row from a
   persistent WhatsApp problem lands after watchdog's own `unseen` snapshot
   is taken, so its seen-marking never catches it — the next 5-minute run
   finds it, alerts again (itself failing to send over WhatsApp the same
   way), and spawns another one: an alert storm that never goes quiet for
   as long as WhatsApp stays broken. Confirmed live by a real test failure
   (cron-watchdog-behavioral.test.ts) the moment a differently-caused but
   identical row started appearing. The Admin App Errors panel has no kind
   filter, so this still shows there; only the "server"-only watchdog
   ignores it, same as any other client-side noise — error-digest (daily,
   kind-agnostic) still reports it once a day for as long as it recurs,
   which is the right amount of noise for a standing configuration gap. */
async function logWaFailure(message: string) {
  try {
    await db.errorLog.create({ data: { kind: "client", message: `WhatsApp: ${message}`.slice(0, 2000) } });
  } catch { /* logging is best-effort */ }
}

function waCreds() {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  return token && phoneId ? { token, phoneId } : null;
}

async function waPost(body: unknown, opts: { quiet?: boolean } = {}) {
  const c = waCreds();
  if (!c) return false;
  try {
    const res = await fetch(`${WA_API}/${c.phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("WhatsApp send failed", res.status, detail);
      if (!opts.quiet) await logWaFailure(`send failed (${res.status}) ${detail}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("WhatsApp send error", e);
    await logWaFailure(`send error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/* Meta only delivers FREE-FORM text inside the 24-hour customer-service window
   (i.e. if the student messaged us recently). Every notification we actually
   care about — "your order is ready" — is proactive and therefore OUTSIDE that
   window, where only an APPROVED TEMPLATE is delivered. So when a template is
   configured we send that; plain text is just the dev/in-window fallback.

   Register one generic utility template (body: a single {{1}} placeholder) and
   set WHATSAPP_ORDER_TEMPLATE to its name — it then covers every update. */
/* Twilio as a WhatsApp provider.

   Twilio's WhatsApp SANDBOX needs no Meta business verification — the recipient
   joins by texting a code once, and messages flow immediately. That makes it
   the practical way to test on a trial account, where Meta's 1-3 day
   verification would otherwise block everything.

   The 24-hour rule still applies: it is Meta's, not Twilio's. Inside the window
   free text is delivered; outside it, only an approved template. In the sandbox
   the window is all you get, so a student must have messaged recently — fine
   for testing, not for launch.

   Env: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM
        (e.g. "whatsapp:+14155238886" for the sandbox) */
function twilioWaCreds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  return sid && token && from ? { sid, token, from } : null;
}

async function twilioWaSend(phone: string, body: string, mediaUrl?: string) {
  const c = twilioWaCreds();
  if (!c) return false;
  const form = new URLSearchParams({
    To: `whatsapp:+91${phone}`,
    From: c.from.startsWith("whatsapp:") ? c.from : `whatsapp:${c.from}`,
    Body: body,
  });
  if (mediaUrl) form.append("MediaUrl", mediaUrl);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${c.sid}:${c.token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) {
      // 63016 = outside the 24h window with no template; the commonest sandbox
      // failure and worth naming rather than logging a bare status code.
      const detail = await res.text().catch(() => "");
      console.error("Twilio WhatsApp send failed", res.status, detail);
      await logWaFailure(`Twilio send failed (${res.status}) ${detail}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Twilio WhatsApp send error", e);
    await logWaFailure(`Twilio send error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function sendWhatsApp(phone: string, text: string) {
  // Twilio first when configured: on a trial account it is the only path that
  // works without Meta business verification.
  if (twilioWaCreds()) {
    await twilioWaSend(phone, text);
    return;
  }
  if (!waCreds()) {
    /* Found 2026-10-01: this used to just `return` here, completely silent —
       a real support case where WHATSAPP_TOKEN/WHATSAPP_PHONE_ID were never
       actually set (or were mistyped) on Render looked IDENTICAL to a
       successful send from the owner's side: no error anywhere, including
       the App Errors panel, which only shows an entry when one exists —
       this path never created one. Logging it the same way a real send
       failure already is means "nothing happened and nothing was logged"
       stops being a possible, silent outcome. */
    await logWaFailure("not sent — WHATSAPP_TOKEN/WHATSAPP_PHONE_ID (or Twilio equivalents) aren't configured");
    return;
  }
  const to = "91" + phone;
  const tpl = process.env.WHATSAPP_ORDER_TEMPLATE;
  if (tpl) {
    const code = process.env.WHATSAPP_TEMPLATE_LANG || "en";
    /* Named parameter, not positional (2026-10-01): Meta's current template
       editor rejects a plain {{1}}-style body outright ("must be lowercase
       characters, underscores and numbers with two sets of curly brackets,
       e.g. {{customer_name}}") — only named variables are accepted now. The
       actual approved template's body is "FabricFold account alert:
       {{alert_message}} — view details in the app.", so the API call must
       address that same name, not position 0, or Meta rejects every send
       with a parameter-mismatch error even once the template is Active. */
    /* Meta error 132018 ("issue with the parameters in your template") —
       template parameters may not contain newlines, tabs, or 4+ consecutive
       spaces. notifyOwner() joins subject and body with "\n", so every
       owner alert was being rejected. Collapse whitespace here, at the one
       choke point every template send passes through, rather than trusting
       each caller to remember it. */
    const cleanText = text.replace(/\s+/g, " ").trim().slice(0, 1000);
    const sent = await waPost({
      messaging_product: "whatsapp", to, type: "template",
      template: { name: tpl, language: { code }, components: [{ type: "body", parameters: [{ type: "text", parameter_name: "alert_message", text: cleanText }] }] },
    });
    await logWaFailure(`trace: template ${tpl} ${sent ? "accepted" : "NOT accepted"} (${to})`);
    if (sent) return;
  }
  /* Free-form text fallback (template missing or rejected by Meta). It only
     delivers inside the owner's 24-hour window, so it is a backstop, not the
     primary path. The failed attempt is quiet so it doesn't flood App Errors. */
  await waPost({ messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } }, { quiet: !!tpl });
}

/* Pull a stored object's bytes back out of Supabase storage. Photos are kept
   private (the app serves them via short-lived signed URLs), so to put one on
   WhatsApp we upload the bytes to Meta rather than exposing a public link. */
async function readStorageObject(key: string) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey || key.startsWith("local/")) return null;
  const bucket = process.env.SUPABASE_BUCKET || "receipts";
  const res = await fetch(`${supaUrl}/storage/v1/object/${bucket}/${key}`, {
    headers: { Authorization: `Bearer ${supaKey}`, apikey: supaKey },
  });
  if (!res.ok) return null;
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") || "image/jpeg" };
}

/* Twilio fetches media from a URL rather than accepting uploaded bytes, so the
   Meta path (upload -> media id) doesn't apply. A Supabase signed URL is
   publicly reachable for its lifetime, which is exactly long enough for Twilio
   to pull the image — and it expires afterwards, so the photo does not become
   permanently public. */
async function signStorageObject(key: string, expiresIn = 600) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey || key.startsWith("local/")) return null;
  const bucket = process.env.SUPABASE_BUCKET || "receipts";
  const res = await fetch(`${supaUrl}/storage/v1/object/sign/${bucket}/${encodeURI(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${supaKey}`, apikey: supaKey, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { signedURL: string };
  return supaUrl + "/storage/v1" + j.signedURL;
}

/** Send stored photos to a student's WhatsApp (damage evidence on a complaint).
    Best-effort: a failed photo is logged, never thrown at the caller. */
export async function sendWhatsAppPhotos(phone: string, keys: string[], caption?: string) {
  if (!keys.length) return;

  if (twilioWaCreds()) {
    for (const [i, key] of keys.entries()) {
      try {
        const url = await signStorageObject(key);
        if (!url) continue;
        await twilioWaSend(phone, i === 0 && caption ? caption : "", url);
      } catch (e) {
        console.error("Twilio WhatsApp photo error", e);
      }
    }
    return;
  }

  const c = waCreds();
  if (!c) return;
  for (const [i, key] of keys.entries()) {
    try {
      const obj = await readStorageObject(key);
      if (!obj) continue;
      // 1. upload the bytes to Meta -> media id
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([obj.bytes as BlobPart], { type: obj.mime }), key.split("/").pop() || "photo.jpg");
      const up = await fetch(`${WA_API}/${c.phoneId}/media`, {
        method: "POST", headers: { Authorization: `Bearer ${c.token}` }, body: form,
      });
      if (!up.ok) {
        console.error("WhatsApp media upload failed", up.status, await up.text().catch(() => ""));
        continue;
      }
      const { id } = (await up.json()) as { id: string };
      // 2. send it — caption rides on the first image only
      await waPost({
        messaging_product: "whatsapp", to: "91" + phone, type: "image",
        image: { id, ...(i === 0 && caption ? { caption } : {}) },
      });
    } catch (e) {
      console.error("WhatsApp photo send error", e);
    }
  }
}

/** In-app notification + realtime broadcast + Web Push + WhatsApp.

    The push and WhatsApp legs run via after(): a bare floating promise is
    abandoned when Vercel freezes the instance after the response — the exact
    failure that once left Sheet rows unsent for hours. after() keeps the
    function alive until the sends finish, without delaying the response. */
export async function pushNotif(studentId: string, text: string, kind = "status") {
  const n = await db.notification.create({ data: { studentId, text, kind } });
  publish([`student:${studentId}`], { type: "notification", payload: { id: n.id, text, kind } });
  const deliver = async () => {
    await sendPushTo("student", studentId, { title: "FabricFold", body: text }).catch(() => {});
    /* Students get in-app and web push only. WhatsApp is for the owner alerts. */
  };
  try {
    const { after } = await import("next/server");
    after(deliver());
  } catch {
    void deliver(); // outside Next (tests, scripts): best effort
  }
  return n;
}

export async function audit(action: string, detail: string, by: string) {
  await db.auditLog.create({ data: { action, detail, by } });
}

/* Bumps Student.lastActivityAt so the staff Students list can sort by
   "recently changed" without a live cross-table scan over orders, payments,
   compensation, cycle use, etc. every render. Call this from the same
   transaction as the change when one exists (accepts `tx`), so the stamp
   can never land without the change it's recording, or vice versa — a
   separate best-effort call outside the transaction could drift (the write
   commits but this doesn't, or this runs then the write rolls back). A
   failed update here is swallowed rather than thrown: the sort going stale
   for one student is a rendering nuisance, not a reason to fail the actual
   refund/order/payment/etc. that called it. */
export async function touchStudentActivity(client: Prisma.TransactionClient | typeof db, studentId: string) {
  try {
    await client.student.update({ where: { id: studentId }, data: { lastActivityAt: new Date() } });
  } catch {
    /* student may not exist yet in an edge case (e.g. mid-erase), or the
       update lost a race with a delete — never let this break the caller */
  }
}

/* Instant WhatsApp alerts to a small fixed list of numbers (owner + up to a
   couple of managers), stored in AppConfig.settings.alertPhones — editable
   in Admin without a redeploy, same pattern as reportEmail. Reuses the
   existing generic-template sendWhatsApp() (see its own comment): one
   approved utility template with a free-text {{1}} body covers every event
   type, no per-event template needed. Called from notifyOwner() (lib/mail.ts)
   so every existing owner-alert call site (registrations, complaints,
   orders, payments) gets WhatsApp for free, not just email. Best-effort —
   one bad number must never break the event that triggered it. */
export async function notifyOwnersWhatsApp(text: string) {
  try {
    // TEMPORARY trace (2026-10-04): entry into the send chain.
    await logWaFailure(`trace: notifyOwnersWhatsApp entered — "${text.slice(0, 40).replace(/\s+/g, " ")}"`);
    const cfg = await db.appConfig.findUnique({ where: { id: "main" }, select: { settings: true } });
    const phones = (cfg?.settings as { alertPhones?: string[] } | null)?.alertPhones || [];
    const clean = phones.filter(Boolean);
    /* Found 2026-10-01, same shape of bug as sendWhatsApp's own "not
       configured" fix just above: zero phones read back from settings — a
       save that silently didn't stick, a key-name mismatch, whatever the
       cause — produced a completely silent no-op here too, console.error
       only (invisible on Render), nothing in the App Errors panel a real
       person can see. This is the first thing that would explain "I saved
       the numbers, triggered an event, got nothing, App Errors shows
       nothing" — logging it so that specific case stops being invisible. */
    if (!clean.length) {
      await logWaFailure("not sent — no alert phone numbers configured in Admin > Settings > WhatsApp alerts");
      return;
    }
    await Promise.allSettled(clean.map((p) => sendWhatsApp(p, text)));
  } catch (e) {
    await logWaFailure(`notifyOwnersWhatsApp error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
