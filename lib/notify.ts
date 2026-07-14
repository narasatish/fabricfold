import { db } from "./db";
import { publish } from "./realtime";
import { sendPushTo } from "./push";

/* WhatsApp order updates via Meta's WhatsApp Cloud API (free tier: 1,000
   conversations/month). Activates when WHATSAPP_TOKEN + WHATSAPP_PHONE_ID are
   set; silently skipped until then. Fire-and-forget — never blocks an order. */
async function sendWhatsApp(phone: string, text: string) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return;
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: "91" + phone, type: "text", text: { body: text } }),
    });
    if (!res.ok) console.error("WhatsApp send failed", res.status, await res.text().catch(() => ""));
  } catch (e) {
    console.error("WhatsApp send error", e);
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
