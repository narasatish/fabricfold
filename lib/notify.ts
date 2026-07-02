import { db } from "./db";
import { publish } from "./realtime";
import { sendPushTo } from "./push";

/** In-app notification + realtime broadcast + Web Push. */
export async function pushNotif(studentId: string, text: string, kind = "status") {
  const n = await db.notification.create({ data: { studentId, text, kind } });
  publish([`student:${studentId}`], { type: "notification", payload: { id: n.id, text, kind } });
  sendPushTo("student", studentId, { title: "FabricFold", body: text }).catch(() => {});
  return n;
}

export async function audit(action: string, detail: string, by: string) {
  await db.auditLog.create({ data: { action, detail, by } });
}
