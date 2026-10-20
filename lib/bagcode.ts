/* Codes printed on the physical bags handed to students.

   B001–B999 bronze · S001–S999 silver · G001–G999 gold · W001–W999 walk-in
   (a student with no subscription who buys a bag).

   The code IS the student's customer ID: printed on the bag, permanent for as
   long as they hold it, and quoted at the counter.

   The code names a physical object, so the rules are strict:
   - RECYCLED, but only deliberately. When a student graduates, staff release
     their code and it returns to the pool for a new student — otherwise 999
     per tier would be a hard ceiling on how many students the campus can ever
     enrol. Reuse happens only through that explicit release.
   - a LOST bag does not change who the student is. They are handed a fresh bag
     with the SAME number printed on it, because an ID that changes whenever
     someone mislays a bag is not an identity. The old row stays, marked lost,
     so the history shows what happened. Consequence, accepted: if the lost bag
     is handed in later, two bags carry that number — destroy the found one.
   - a PLAN CHANGE does change the code, because the letter tells staff the
     entitlement, and B on a Gold plan would be a lie.
   - one code never names two students AT ONCE — enforced in the database by a
     partial unique index over ACTIVE bags, not merely by this allocator.
   - unique WITHIN its own letter, not across letters (reversed 2026-10-19,
     owner: the earlier "one shared number line across every letter" design —
     S1001, F1002, G1003 consuming one global counter so a bare number alone
     identified a bag — was itself the owner's own explicit, deliberate
     request at the time (see allocateBagCode's history below). Reversed
     because it has a real cost in practice: the two campuses are run as
     separate rosters (St Mary's S/B/G, BVRIT V), and a global number pool
     means registering a St Mary's student can be blocked by a BVRIT number
     the staff member has no way to see (campus-scoped roster views don't
     show the other campus's bags at all — see app/s/students/page.tsx) —
     found live 2026-10-19 registering S1546 against an existing V1546. The
     letter is already part of the printed code; a student only needs to be
     found unambiguously by their FULL code (letter + number), and the full
     code's uniqueness is still enforced in the database by the
     bag_code_one_active_uniq partial index exactly as before. Each letter
     now draws from its own counter (see allocateBagCode), so B/S/G/F and V
     can and will repeat the same number without colliding.

   Backed by the same transactional FySequence table as invoice numbering, so
   two counters issuing bags in the same instant cannot collide. */
import { Prisma } from "./generated/prisma/client";
import { dbSchemaPrefix } from "./db";

export const TIERS = ["bronze", "silver", "gold"] as const;
export type Tier = (typeof TIERS)[number];

/** Subscribed students get their tier's letter; a St Mary's student with no
    plan yet defaults to Bronze (owner, Sep 22: "for st marys we need to use
    B,S,G thats all... no need of W for walkins") — it is corrected to their
    real tier the moment they subscribe (syncBagToPlan). College FACULTY get
    their own F series regardless of campus (owner, Sep 2026: "we have given
    code as F ... it will be same like F1100") — they buy cycle packs rather
    than tiered plans, so no tier letter fits them, and the counter needs to
    see at a glance that a bag belongs to a teacher, at either college.
    BVRIT STUDENTS (not faculty) are always V (owner, Sep 22: "for bvrit we
    need to use only V as code") — see registerStudent, which checks kind ===
    "faculty" BEFORE college, so a BVRIT student is V but BVRIT faculty is
    still F, the same as St Mary's faculty. (This comment previously said
    "BVRIT is ALWAYS V, students and faculty alike" — that was wrong and
    contradicted the actual allocateBagCode(tx, isFaculty ? "faculty" :
    "bvrit") call in registerStudent; fixed to match the real, live
    behavior — a real BVRIT faculty record in the DB carries F1007, not a
    V-code.) */
export type BagKind = Tier | "faculty" | "bvrit";

export const BAG_LETTER: Record<BagKind, string> = { bronze: "B", silver: "S", gold: "G", faculty: "F", bvrit: "V" };
export const BAG_LABEL: Record<BagKind, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", faculty: "Faculty", bvrit: "BVRIT" };

/** Highest sequence a single kind can issue before the scheme needs widening.

    Widened from 999 (Sep 2026): the owner's printed stock is numbered from
    1000 (B1001, G1002…), so the ceiling moved to four digits. Three-digit
    codes already in the database stay valid — a printed bag is never
    invalidated by a numbering change. */
export const MAX_PER_KIND = 9999;

/** New codes START here, because 1000-series bags are what is physically
    printed. The 1–999 range is reserved for codes that already exist. */
export const MINT_FROM = 1000;

/** Start warning here. Running out is not recoverable at the counter — bags are
    printed in advance — so the Owner needs lead time, not a surprise error. */
export const WARN_AT = 9900;

export function codesRemaining(lastIssued: number) {
  return Math.max(0, MAX_PER_KIND - lastIssued);
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** A plan tier if there is one, otherwise Bronze — the default until a real
 *  plan is chosen (owner, Sep 22: no separate walk-in series any more). */
export function bagKindFor(tier: string | null | undefined): BagKind {
  return isTier(tier) ? tier : "bronze";
}

/** "bronze", 42 → "B042"; "gold", 1002 → "G1002". Three digits below 1000
    (matching bags already printed that way), plain number above. */
export function formatBagCode(kind: BagKind, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_KIND) return null;
  return BAG_LETTER[kind] + (n < 1000 ? String(n).padStart(3, "0") : String(n));
}

/** "B042" or "G1002" → { kind, n }. Null for anything malformed. */
export function parseBagCode(code: string): { kind: BagKind; n: number } | null {
  /* A 4-digit code may not lead with 0: "B0001" is a mistyping of B001, and
     a parser that guesses which code a smudge meant will one day hand a bag
     to the wrong student. Canonical forms only. */
  const m = /^([BSGWFV])(\d{3}|[1-9]\d{3})$/.exec((code || "").trim().toUpperCase());
  if (!m) return null;
  const kinds = Object.keys(BAG_LETTER) as BagKind[];
  const kind = kinds.find((k) => BAG_LETTER[k] === m[1]);
  const n = Number(m[2]);
  if (!kind || n < 1 || n > MAX_PER_KIND) return null;
  return { kind, n };
}

/** Claim a code for a kind. Call inside the transaction that creates the Bag
    row, so a rolled-back handover doesn't burn a code.

    Released codes are reused BEFORE minting a new number, and the lowest one
    goes first. Two reasons: the printed stock is reused in the order it comes
    back, and the numbers stay dense — a campus of 300 students should be
    holding B001–B300, not drifting toward B999 with gaps where graduates were. */
export async function allocateBagCode(tx: Prisma.TransactionClient, kind: BagKind) {
  const letter = BAG_LETTER[kind];

  /* A code is free when some bag row released it and no LIVE row holds it.
     Both halves are needed: a code can be released once and later re-issued,
     so the released row alone doesn't prove it is available now. */
  const [released, live] = await Promise.all([
    tx.bag.findMany({
      where: { status: "released", code: { startsWith: letter } },
      select: { code: true },
      orderBy: { code: "asc" },
    }),
    tx.bag.findMany({
      where: { status: { not: "released" }, code: { startsWith: letter } },
      select: { code: true },
    }),
  ]);
  const taken = new Set(live.map((b) => b.code));
  const recycled = released.find((r) => !taken.has(r.code));
  if (recycled) return recycled.code;

  /* ONE number line PER LETTER (reversed 2026-10-19 from a single shared
     line across every letter — see the file-header comment for why). The
     FySequence row is now keyed by the letter itself, so B/S/G/F/V each
     mint independently and the same number can legitimately appear under
     more than one letter (S1546 and V1546 coexisting is correct now, not a
     collision).

     Sequence starts at MINT_FROM: printed stock is numbered from 1000, and a
     freshly minted #1037 would clash with nothing in the database while
     matching no bag anyone can hold. `value` always means "the last number
     ISSUED" (never "the next one to issue") — every path below ends with one
     unconditional increment before formatting the code, so MINT_FROM is a
     baseline to land ON, then step PAST, giving 1001 as the true first code.

     Defensive floor (new 2026-10-19, needed because this is a live
     migration off the old shared-pool scheme, not a fresh start): before
     relying on the counter alone, also check the highest number any LIVE
     bag of this letter already carries (from the old shared-pool era, a
     letter's live codes can already sit above MINT_FROM, e.g. existing V
     codes minted while V shared the old pool) and never hand out a number
     at or below that. This makes the switch safe regardless of what the
     old shared counter or existing rows already contain — it can only ever
     move a letter's next number UP to stay clear of its own history, never
     down, so BVRIT's first mint under the new scheme lands on 1001 exactly
     when the data allows it (owner, 2026-10-19: "give numbers for bvrit
     student from 1001"), and skips ahead automatically if it can't. */
  // A plain SQL MAX(code) sorts lexicographically ("V999" > "V1546" as
  // strings), which would silently pick the wrong floor whenever 3-digit and
  // 4-digit codes mix for the same letter — so the max is computed here, in
  // JS, off the parsed NUMBER, not the string.
  const existingCodes = await tx.bag.findMany({ where: { code: { startsWith: letter } }, select: { code: true } });
  const existingMaxN = existingCodes.reduce((max, b) => Math.max(max, parseBagCode(b.code)?.n ?? 0), 0);
  const floor = Math.max(MINT_FROM, existingMaxN);

  /* A plain findUnique-then-create(-else-update) is a classic find-then-act
     race: two concurrent FIRST-EVER mints for the SAME letter both see no
     row, both attempt to create one, and the loser gets an unhandled P2002.
     Normally a narrow, once-ever window — but today's rewrite to per-letter
     rows (from one single shared row) means all five letters are freshly
     cold at once, right at this deploy, not "once in the app's lifetime" —
     found 2026-10-20 in a deep audit. Replaced with a single atomic
     `INSERT ... ON CONFLICT DO UPDATE`, which Postgres serializes at the row
     level regardless of concurrent callers — no separate read-then-write
     steps left to race. GREATEST(...) on the conflict branch is what the two
     old separate update calls (bump-to-floor, then increment) used to do in
     two steps; done here in the one atomic statement instead. */
  const table = Prisma.raw(`${dbSchemaPrefix}"FySequence"`);
  const [row] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO ${table} (kind, "fyTag", value)
    VALUES ('bagcode', ${letter}, ${floor + 1})
    ON CONFLICT (kind, "fyTag") DO UPDATE SET value = GREATEST("FySequence".value, ${floor}) + 1
    RETURNING value`;
  const code = formatBagCode(kind, row.value);
  if (!code) {
    throw new Error(
      `All ${MAX_PER_KIND} ${BAG_LABEL[kind]} bag codes are in use — release codes from students who have left, or widen the code scheme.`,
    );
  }
  return code;
}

/** The Customer ID to show for a student: their active bag's code if they
    have one, otherwise a freshly-minted code issued on the spot — the
    letter picked the same way registerStudent()/issueBag/import/
    wa-register.ts already pick it: FACULTY carry the F series regardless
    of college or what they've bought (same rule as issueBag — "the letter
    tells the counter WHO this is"), BVRIT gets V, a subscriber gets their
    PLAN's tier letter (bronze→B, silver→S, gold→G, per lib/bagcode.ts and
    the owner's own enrolment sheet — imported bag codes are honoured
    exactly, this only applies when there truly is no bag row yet).

    A student created before their registration path issued a code (old
    seed data, an old signup, a subscription activated without ever going
    through sellSubscription's bag step) has no bag row at all — and
    displaying student.id for them shows a bare internal number next to
    every OTHER student's B/S/G/V/F code, which reads as a different, wrong
    ID scheme (owner, Sep 2026, reported repeatedly: BVRIT V-codes, St
    Mary's tier codes — "based on the plan chosen St Mary's students get
    IDs G for gold, S for silver, B for bronze" — and faculty F-codes —
    "we have given code as F ... it will be same like F1100"). This heals
    the gap the first time any screen asks for the Customer ID, rather
    than requiring a separate migration — a true walk-in with neither a
    BVRIT account, faculty kind, nor an active subscription legitimately
    has no bag yet and still falls back to student.id, which is correct
    there. */
export async function customerIdFor(
  db: typeof import("./db").db,
  student: { id: string; collegeId: string; kind?: string | null },
  collegeName: string | undefined,
): Promise<string> {
  const existing = await db.bag.findFirst({
    where: { studentId: student.id, status: "active" },
    orderBy: { issuedAt: "desc" },
    select: { code: true },
  });
  if (existing) return existing.code;

  /* Found live 2026-09-16: this used to auto-mint for ANY student with no
     ACTIVE bag, which does not distinguish "never had a code" (the real gap
     this heal exists for) from "a Manager deliberately released their code
     because the student left" — releaseBagCode leaves exactly this state on
     purpose. A departed student's profile re-rendering (router.refresh()
     after the release) called this function, saw no active bag, and
     immediately re-minted them a fresh one — burning a new code on someone
     who was just released, seconds after release, defeating the entire
     point of "Student left" and silently reactivating an account that was
     meant to free its slot. Only heal when the student has NO bag row at
     all, ever (truly never touched by the code system) — any row, even a
     released/lost one, means this state is deliberate and must not be
     auto-corrected. */
  const everHadABag = await db.bag.findFirst({ where: { studentId: student.id }, select: { id: true } });
  if (everHadABag) return student.id;

  // Every student gets a real customer-facing code the moment they have none —
  // previously this fell all the way through to `return student.id` for a
  // plan-less, non-BVRIT, non-faculty student, showing the internal 6-digit
  // row key as their "customer ID" everywhere in the app — found live (owner,
  // Sep 21). Faculty are F at either college (a college-agnostic rule, set
  // earlier); otherwise BVRIT is always V (owner, Sep 22: "for bvrit... only
  // V"), and St Mary's defaults to Bronze until a real plan is chosen
  // (bagKindFor) — staff assign the plan right after registering a walk-in,
  // and syncBagToPlan then swaps this provisional code for the real tier.
  let kind: BagKind;
  if (student.kind === "faculty") {
    kind = "faculty";
  } else if (collegeName?.trim().toUpperCase() === "BVRIT") {
    kind = "bvrit";
  } else {
    const sub = await db.subscription.findUnique({
      where: { studentId: student.id },
      select: { active: true, planRef: { select: { tier: true } } },
    });
    kind = bagKindFor(sub?.active ? sub.planRef?.tier : null);
  }

  /* Two real bugs fixed here 2026-10-20, found by a deep audit:
     (1) RACE — no lock, no re-check inside a transaction. Two concurrent
     calls for the same never-bagged student (realistic: two Sheet-event call
     sites racing for the same new student, e.g. complaints.ts and orders.ts
     both resolving a Customer ID around the same moment) both pass the
     everHadABag check above, both allocate a DIFFERENT code, and both
     successfully create a Bag — nothing catches it, since bag_code_one_active_
     uniq only protects one CODE from being reused, not "one active bag per
     student". Result: a student silently ends up holding two simultaneously
     active customer IDs. Fixed with the SAME advisory lock key issueBag uses
     ("bag-issue|${studentId}") — the two code paths now serialize against
     EACH OTHER too, not just against themselves.
     (2) CRASH — `db` here is sometimes actually a `Prisma.TransactionClient`
     (every caller inside lib/sheet-events.ts's customerIdFor wrapper passes
     `tx`, not the top-level client), and a TransactionClient has no
     `$transaction` method (Prisma doesn't support nesting transactions) — so
     a self-heal triggered from inside an already-open transaction (e.g. a
     student with zero bags reaching this via acceptOrder/collectOrder/
     payInner/sellCyclePack's own customerIdFor(tx,...) call) used to throw
     "tx.$transaction is not a function", aborting the WHOLE enclosing
     transaction with a confusing internal error instead of just minting a
     bag. Fixed by detecting which kind of client was handed in: open a new
     transaction only when given the top-level client; when already inside
     one (`db` lacks `$transaction`), do the lock + write directly against
     it — advisory locks are scoped to the current transaction regardless of
     which one that is. */
  const mint = async (client: Prisma.TransactionClient) => {
    await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bag-issue|${student.id}`}))`;
    // Re-check fresh, now that nothing else can be concurrently minting for
    // this student — someone else (this function or issueBag, racing on the
    // same lock key) may have created one while this call waited.
    const nowHasOne = await client.bag.findFirst({ where: { studentId: student.id, status: "active" }, select: { code: true } });
    if (nowHasOne) return nowHasOne.code;
    const code = await allocateBagCode(client, kind!);
    await client.bag.create({
      data: { code, studentId: student.id, tier: isTier(kind) ? kind : null, complimentary: true, issuedBy: "system", status: "active" },
    });
    return code;
  };
  return typeof (db as { $transaction?: unknown }).$transaction === "function"
    ? (db as typeof import("./db").db).$transaction((tx) => mint(tx))
    : mint(db as unknown as Prisma.TransactionClient);
}
