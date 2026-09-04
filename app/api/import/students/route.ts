/* Bulk student import from the owner's Excel sheet.

   The sheet is the enrolment ledger the business already runs on: name,
   mobile, and the customer ID printed on the bag (B1001 / S1009 / G1100 —
   letter = tier, number = the owner's own series). The import honours those
   IDs exactly; nothing is re-numbered, because the number is physically
   printed on a bag in a student's room.

   Money, deliberately NOT imported: these plans were paid for in cash before
   the app existed, so no Payment row and no GST invoice is minted — invoice
   numbering is gap-free per financial year, and 500 invoices dated today for
   weeks-old cash would misstate the legal record. The subscription is simply
   active, with a note that payment happened out-of-band.

   Per-row, not all-or-nothing: one bad phone number in row 40 must not throw
   away rows 1–39. Every skipped row is reported with its reason and number so
   the owner can fix the sheet and re-upload — and re-uploads are safe, because
   an already-registered mobile is skipped, never overwritten. */
import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import { rosterSoon } from "@/lib/sheets-sync";
import { requireStaff, assertSameCollege, AuthError } from "@/lib/auth";
import { parseBagCode, BAG_LETTER, type Tier } from "@/lib/bagcode";

/* Mirrors the private helpers in lib/actions/subscription.ts — they live in a
   "use server" module, which may only export async functions, so they cannot
   be imported here. Kept byte-for-byte in step; a drift would let an imported
   subscription snapshot differently from a sold one. */
type PlanBucket = { service: string; cycles: number; kgPerCycle: number };
function usageBuckets(buckets: PlanBucket[]) {
  return buckets.map((b) => ({ service: b.service, cycles: b.cycles, used: 0, kgPerCycle: b.kgPerCycle }));
}
async function planGross(plan: { price: unknown; gstFree: boolean }) {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false && !plan.gstFree;
  const price = Number(plan.price);
  return price + (gstOn ? Math.round(price * Number(cfg.gstPct) / 100) : 0);
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = {
  name: ["name", "student", "student name", "customer name"],
  phone: ["phone", "mobile", "mobile number", "phone number", "number"],
  code: ["code", "customer id", "customerid", "bag", "bag code", "id", "tag", "unique code"],
  amount: ["amount", "paid", "price", "fee", "plan price (₹)"],
};

function headerIndex(row: ExcelJS.Row) {
  const map: Partial<Record<keyof typeof HEADERS, number>> = {};
  row.eachCell((cell, col) => {
    const v = String(cell.value ?? "").trim().toLowerCase();
    for (const [key, aliases] of Object.entries(HEADERS)) {
      if (aliases.includes(v)) map[key as keyof typeof HEADERS] = col;
    }
  });
  return map;
}

const cellText = (row: ExcelJS.Row, col?: number) => {
  if (!col) return "";
  const v = row.getCell(col).value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  if (typeof v === "object" && "text" in v) return String(v.text ?? "");
  return String(v);
};

export async function POST(req: Request) {
  let staff;
  try {
    staff = await requireStaff(3); // Admin+ — this creates accounts and activates plans
  } catch (e) {
    return new Response((e as AuthError).message, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const collegeId = String(form?.get("collegeId") ?? "");
  if (!(file instanceof File)) return Response.json({ ok: false, error: "Attach the .xlsx file" }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return Response.json({ ok: false, error: "File too large — 5 MB max" }, { status: 400 });

  try {
    assertSameCollege(staff, collegeId);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 401 });
  }
  const college = await db.college.findUnique({ where: { id: collegeId } });
  if (!college || !college.active) return Response.json({ ok: false, error: "Pick a campus" }, { status: 400 });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return Response.json({ ok: false, error: "Couldn't read that file — export it as .xlsx and try again" }, { status: 400 });
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) return Response.json({ ok: false, error: "The sheet looks empty" }, { status: 400 });
  // Each row does a handful of sequential awaits (existsPhone/bag lookups),
  // so an unbounded sheet risks a partial, silently-truncated import once the
  // route's maxDuration is hit — same 500-row ceiling as the text-paste path.
  if (ws.rowCount - 1 > 500) {
    return Response.json({ ok: false, error: "Max 500 students per import — split the sheet and upload in batches" }, { status: 400 });
  }

  const cols = headerIndex(ws.getRow(1));
  if (!cols.name || !cols.phone || !cols.code) {
    return Response.json({
      ok: false,
      error: "Header row must have Name, Mobile and Customer ID columns (first sheet, first row)",
    }, { status: 400 });
  }

  // Plans by tier for this campus, resolved once.
  const plans = await db.plan.findMany({ where: { collegeId, active: true, tier: { in: ["bronze", "silver", "gold"] } } });
  const planByTier = new Map(plans.map((p) => [p.tier as Tier, p]));

  const added: string[] = [];
  const skipped: string[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const maxPerLetter = new Map<string, number>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(row, cols.name).trim();
    const phone = cellText(row, cols.phone).replace(/\D/g, "").slice(-10);
    const codeRaw = cellText(row, cols.code).trim().toUpperCase();
    const amount = cols.amount ? Number(cellText(row, cols.amount).replace(/[^\d.]/g, "")) : null;
    if (!name && !phone && !codeRaw) continue; // blank row

    if (name.length < 2) { problems.push(`row ${r}: name missing`); continue; }
    if (phone.length !== 10) { problems.push(`row ${r}: "${name}" — mobile must be 10 digits`); continue; }
    const parsed = parseBagCode(codeRaw);
    if (!parsed || parsed.kind === "walkin") { problems.push(`row ${r}: "${name}" — customer ID "${codeRaw}" isn't B/S/G/F + number`); continue; }

    /* FACULTY rows (F codes) register the person and their bag, nothing
       more: faculty buy cycle packs at the counter (sellCyclePack), so an
       import that invented a subscription would invent money. */
    const isFaculty = parsed.kind === "faculty";
    const tier = isFaculty ? null : (parsed.kind as Tier);
    const plan = tier ? planByTier.get(tier) : null;
    if (!isFaculty) {
      if (!plan) { problems.push(`row ${r}: "${name}" — no active ${tier} plan exists for ${college.name}; create it in Admin first`); continue; }
      /* A plan whose buckets JSON is empty would import a subscription with 0
         cycles — active on paper, unusable at the counter. Refuse loudly. */
      const pb = (plan.buckets as unknown as PlanBucket[] | null) ?? [];
      if (!pb.length || pb.reduce((n, b) => n + (b.cycles || 0), 0) === 0) {
        problems.push(`row ${r}: "${name}" — the ${tier} plan has no cycles configured; fix the plan in Admin first`);
        continue;
      }
    }
    const planBuckets = plan ? ((plan.buckets as unknown as PlanBucket[] | null) ?? []) : [];

    // Amount is a CROSS-CHECK, never the source of truth — the letter is
    // printed on a physical bag; a discount changes the amount, not the tier.
    if (plan && amount && Math.abs(amount - Number(await planGross(plan))) > 1) {
      warnings.push(`row ${r}: "${name}" paid ₹${amount}, ${tier} plan is ₹${await planGross(plan)} — imported as ${tier} (the bag letter wins)`);
    }

    const existsPhone = await db.student.findUnique({ where: { phone } });
    if (existsPhone) { skipped.push(`row ${r}: ${phone} already registered (${existsPhone.name})`); continue; }
    const codeTaken = await db.bag.findFirst({ where: { code: codeRaw, status: "active" }, include: { student: true } });
    if (codeTaken) { problems.push(`row ${r}: "${name}" — ${codeRaw} is already ${codeTaken.student.name}'s active bag`); continue; }

    try {
      await db.$transaction(async (tx) => {
        // internal 6-digit id, same scheme as counter registration; the
        // VISIBLE customer id is the bag code, honoured exactly as given
        let id = "";
        for (let i = 0; i < 20; i++) {
          id = String(Math.floor(100000 + Math.random() * 900000));
          if (!(await tx.student.findUnique({ where: { id } }))) break;
        }
        await tx.student.create({ data: { id, phone, name, collegeId, kind: isFaculty ? "faculty" : "student" } });

        if (plan) {
          const buckets = usageBuckets(planBuckets);
          const cyclesTotal = buckets.reduce((s: number, b: { cycles: number }) => s + b.cycles, 0);
          await tx.subscription.create({
            data: {
              studentId: id, active: true, plan: plan.name, planId: plan.id,
              buckets: buckets as unknown as object, cyclesTotal, kgPerCycle: 5,
              startedAt: new Date(),
            },
          });
        }
        await tx.bag.create({
          data: { code: codeRaw, studentId: id, tier, complimentary: true, price: 0, issuedBy: staff.id, note: isFaculty ? "imported from faculty sheet" : "imported from enrolment sheet" },
        });
      });
      added.push(`${name} — ${codeRaw}`);
      const letter = BAG_LETTER[parsed.kind];
      maxPerLetter.set(letter, Math.max(maxPerLetter.get(letter) ?? 0, parsed.n));
    } catch (e) {
      problems.push(`row ${r}: "${name}" — ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
    }
  }

  /* Bump the allocator past every imported number, per letter, so a future
     "sell a bag" can never mint a code the owner has already printed. */
  for (const [letter, maxN] of maxPerLetter) {
    const row = await db.fySequence.findUnique({ where: { kind_fyTag: { kind: "bagcode", fyTag: letter } } });
    if (!row || row.value < maxN) {
      await db.fySequence.upsert({
        where: { kind_fyTag: { kind: "bagcode", fyTag: letter } },
        create: { kind: "bagcode", fyTag: letter, value: maxN },
        update: { value: maxN },
      });
    }
  }

  await db.auditLog.create({
    data: {
      action: "Students imported",
      detail: `${college.name}: ${added.length} added, ${skipped.length} skipped, ${problems.length} problems (sheet: ${file.name})`,
      by: staff.id,
    },
  });

  rosterSoon();
  return Response.json({ ok: true, added, skipped, problems, warnings });
}
