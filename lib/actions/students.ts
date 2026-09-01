"use server";
/* Admin student tools: bulk import and campus-wide broadcast. */
import { db } from "../db";
import { requireStaff } from "../auth";
import { audit } from "../notify";
import { washDayDistribution } from "../washday-server";

/**
 * Find students by customer ID, phone or name — on the SERVER.
 *
 * The staff home screen used to receive the entire student table and filter
 * it in the browser to show ten matches. That shipped every student on every
 * render of a screen that refreshes every ten seconds, and it still only
 * searched what had been sent.
 *
 * Capped at 20: the counter is looking for one person, and an unbounded LIKE
 * is exactly the query that gets slow once it matters.
 */
export async function searchStudents(query: string) {
  await requireStaff(1);
  const q = (query || "").trim();
  // Two characters is the point where a search stops meaning "everyone".
  if (q.length < 2) return { ok: true as const, students: [] };

  /* The phone clause is OMITTED when the query has no digits, rather than
     given a value that cannot match. The first version used a NUL character
     as that never-match sentinel and Postgres rejected the entire query — NUL
     is not valid UTF-8 input — so searching any name returned nothing at all.
     Caught by exercising the box in a browser; the source-level tests were
     perfectly happy with it. */
  const digits = q.replace(/\D/g, "");
  const or: Array<Record<string, unknown>> = [
    { id: { contains: q } },
    { name: { contains: q, mode: "insensitive" } },
  ];
  if (digits.length >= 2) or.push({ phone: { contains: digits } });

  const students = await db.student.findMany({
    where: { OR: or },
    select: { id: true, name: true, phone: true },
    orderBy: { name: "asc" },
    take: 20,
  });
  return { ok: true as const, students };
}

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

  // Wash-day spread: start from this college's CURRENT distribution (not a
  // fresh count), so a bulk import continues the round-robin rather than
  // resetting it — otherwise every batch would pile onto the same weekdays.
  const closedWeekday = (await db.college.findUnique({ where: { id: collegeId }, select: { closedWeekday: true } }))?.closedWeekday ?? null;
  const load = await washDayDistribution(collegeId); // index 0-6 -> count
  const openDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== closedWeekday);
  const nextDay = () => {
    let best = openDays[0], bestCount = load[best];
    for (const d of openDays) if (load[d] < bestCount) { best = d; bestCount = load[d]; }
    load[best]++; // reserve it in-memory so the next student in this batch gets a different day
    return best;
  };

  let created = 0;
  const skipped: { line: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const { name, phone } = parseLine(line);
    if (phone.length !== 10) { skipped.push({ line, reason: "no valid 10-digit phone" }); continue; }
    if (seen.has(phone)) { skipped.push({ line, reason: "duplicate in list" }); continue; }
    seen.add(phone);
    if (await db.student.findUnique({ where: { phone } })) { skipped.push({ line, reason: "already registered" }); continue; }
    // washDay deliberately NOT set — the rota is parked; drop off any day.
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
