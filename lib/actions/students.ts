"use server";
/* Admin student tools: bulk import and campus-wide broadcast. */
import { db } from "../db";
import { requireStaff } from "../auth";
import { audit } from "../notify";

const rid = () => String(Math.floor(100000 + Math.random() * 900000));
async function uniqueId() {
  for (let i = 0; i < 25; i++) { const id = rid(); if (!(await db.student.findUnique({ where: { id } }))) return id; }
  return rid();
}

/** Parse one line into { name, phone }. Accepts "Name, 98765..." / "98765 Name" / tab-separated. */
function parseLine(line: string): { name: string; phone: string } {
  const parts = line.split(/[,\t]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  let phone = "", nameBits: string[] = [];
  for (const p of parts) {
    const digits = p.replace(/\D/g, "");
    if (!phone && digits.length >= 10) phone = digits.slice(-10);
    else nameBits.push(p);
  }
  if (!phone) { const d = line.replace(/\D/g, ""); if (d.length >= 10) phone = d.slice(-10); }
  const name = nameBits.join(" ").replace(/[+\d]/g, "").trim() || "Student";
  return { name, phone };
}

/** Register many students at once (any staff). Skips duplicates and bad rows. */
export async function bulkRegisterStudents(text: string, collegeId: string) {
  const st = await requireStaff(1);
  const college = await db.college.findUnique({ where: { id: collegeId } });
  if (!college || !college.active) return { ok: false as const, error: "Pick a campus" };

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false as const, error: "Paste at least one student" };
  if (lines.length > 500) return { ok: false as const, error: "Please import 500 or fewer at a time" };

  let created = 0;
  const skipped: { line: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const { name, phone } = parseLine(line);
    if (phone.length !== 10) { skipped.push({ line, reason: "no valid 10-digit phone" }); continue; }
    if (seen.has(phone)) { skipped.push({ line, reason: "duplicate in list" }); continue; }
    seen.add(phone);
    if (await db.student.findUnique({ where: { phone } })) { skipped.push({ line, reason: "already registered" }); continue; }
    await db.student.create({ data: { id: await uniqueId(), phone, name, collegeId } });
    created++;
  }
  await audit("Bulk student import", `${created} added to ${college.name}${skipped.length ? `, ${skipped.length} skipped` : ""}`, st.id);
  return { ok: true as const, created, skipped };
}

/** Send a notice to every student at a campus (or all campuses). Manager+. */
export async function broadcastNotice(scope: string, text: string) {
  const st = await requireStaff(2);
  const msg = text.trim();
  if (msg.length < 3) return { ok: false as const, error: "Enter a message" };
  const where = scope === "all" ? {} : { collegeId: scope };
  const students = await db.student.findMany({ where, select: { id: true } });
  if (!students.length) return { ok: false as const, error: "No students to notify" };
  const ids = students.map((s) => s.id);

  // one in-app notification per student
  await db.notification.createMany({ data: ids.map((studentId) => ({ studentId, text: msg, kind: "status" as const })) });

  // best-effort Web Push to everyone subscribed (one query, then fan out)
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:support@fabricfold.in", pub, priv);
    const subs = await db.pushSubscription.findMany({ where: { userKind: "student", userId: { in: ids } } });
    await Promise.allSettled(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "FabricFold", body: msg }))
        .catch(async (e: unknown) => {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }),
    ));
  }

  const label = scope === "all" ? "all campuses" : (await db.college.findUnique({ where: { id: scope } }))?.name || scope;
  await audit("Broadcast notice", `"${msg.slice(0, 40)}" → ${label} (${ids.length})`, st.id);
  return { ok: true as const, sent: ids.length };
}
