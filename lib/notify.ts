import { db } from "./db";
import { publish } from "./realtime";
import { sendPushTo } from "./push";

/* WhatsApp via Meta's WhatsApp Cloud API. Activates when WHATSAPP_TOKEN +
   WHATSAPP_PHONE_ID are set; silently skipped until then. Fire-and-forget —
   never blocks an order. */
const WA_API = "https://graph.facebook.com/v20.0";

function waCreds() {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  return token && phoneId ? { token, phoneId } : null;
}

async function waPost(body: unknown) {
  const c = waCreds();
  if (!c) return false;
  try {
    const res = await fetch(`${WA_API}/${c.phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("WhatsApp send failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("WhatsApp send error", e);
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
      return false;
    }
    return true;
  } catch (e) {
    console.error("Twilio WhatsApp send error", e);
    return false;
  }
}

async function sendWhatsApp(phone: string, text: string) {
  // Twilio first when configured: on a trial account it is the only path that
  // works without Meta business verification.
  if (twilioWaCreds()) {
    await twilioWaSend(phone, text);
    return;
  }
  if (!waCreds()) return;
  const to = "91" + phone;
  const tpl = process.env.WHATSAPP_ORDER_TEMPLATE;
  if (tpl) {
    const code = process.env.WHATSAPP_TEMPLATE_LANG || "en";
    const sent = await waPost({
      messaging_product: "whatsapp", to, type: "template",
      template: { name: tpl, language: { code }, components: [{ type: "body", parameters: [{ type: "text", text }] }] },
    });
    if (sent) return;
  }
  await waPost({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
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
    const s = await db.student.findUnique({ where: { id: studentId }, select: { phone: true } }).catch(() => null);
    if (s) await sendWhatsApp(s.phone, text).catch(() => {});
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
