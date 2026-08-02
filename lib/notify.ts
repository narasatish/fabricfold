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
async function sendWhatsApp(phone: string, text: string) {
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

/** Send stored photos to a student's WhatsApp (damage evidence on a complaint).
    Best-effort: a failed photo is logged, never thrown at the caller. */
export async function sendWhatsAppPhotos(phone: string, keys: string[], caption?: string) {
  const c = waCreds();
  if (!c || !keys.length) return;
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

/** In-app notification + realtime broadcast + Web Push + WhatsApp. */
export async function pushNotif(studentId: string, text: string, kind = "status") {
  const n = await db.notification.create({ data: { studentId, text, kind } });
  publish([`student:${studentId}`], { type: "notification", payload: { id: n.id, text, kind } });
  sendPushTo("student", studentId, { title: "FabricFold", body: text }).catch(() => {});
  db.student.findUnique({ where: { id: studentId }, select: { phone: true } })
    .then((s) => (s ? sendWhatsApp(s.phone, text) : undefined))
    .catch(() => {});
  return n;
}

export async function audit(action: string, detail: string, by: string) {
  await db.auditLog.create({ data: { action, detail, by } });
}
