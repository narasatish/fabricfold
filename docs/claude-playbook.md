# FabricFold playbook

Read this before SEO, production-debugging, or deploy work. It exists so lessons
learned don't have to be re-derived from scratch in a future session.

## The single most important rule in this codebase

**Campus (college) isolation must never break.** FabricFold serves multiple
campuses from one app; a staff member scoped to one campus must never see,
edit, or influence another campus's data. This has been the single largest
source of real bugs found in this codebase (see the Sep 2026 audit log below).

### The guard, and its blind spot

`assertSameCollege(st, targetCollegeId)` in `lib/auth.ts` is the enforcement
mechanism. It's a no-op when `st.collegeId` is `null` (Owner, role 4, sees
everything by design); otherwise it throws unless the ids match.

**Every `lib/actions/*.ts` server action that takes an entity id and is
staff-callable has this check — confirmed by an exhaustive sweep, 87/87
functions, zero gaps.**

**The blind spot: server components (`page.tsx` files) that query the
database directly.** A page doesn't go through `lib/actions/*`, so it doesn't
inherit `assertSameCollege` automatically. On 2026-09-05 this was found to be
a real, live, CRITICAL bug: `app/s/customers/[id]/page.tsx` and
`app/s/orders/[id]/page.tsx` had **zero campus check** — any authenticated
staff member, any role, any campus, could view any other campus's full
student or order record just by knowing/guessing an id. Five more pages
(`app/s/page.tsx`, `app/s/students/page.tsx`, `app/s/complaints/page.tsx`,
`app/s/admin/page.tsx`, `app/s/reports/page.tsx`) shipped full cross-campus
datasets to the browser and relied on a **client-side** switcher to only
*display* one campus — the data was already there for anyone to read via
devtools.

**The rule going forward: any new `page.tsx` under `app/s/**` that queries
the database directly MUST add its own explicit campus check** — either
`where: { collegeId: staff.collegeId ?? undefined }` on every query that
returns campus-scoped rows, or (for a page keyed to one entity by id, like a
detail page) `if (staff.collegeId && staff.collegeId !== row.collegeId) redirect(...)`
right after loading the row. There is no lint or test that catches a missing
filter automatically — this has to be a manual discipline every time a new
staff page is added. When in doubt, grep `app/s/page.tsx` for the `scope`
pattern used there and copy it.

### Owner's collegeId must be null

The whole scheme depends on Owner-role (role 4) staff having `collegeId:
null` in their `Staff` row. `prisma/seed.ts` briefly had this wrong (seeded
the Owner with a real campus id) — fixed 2026-09-05. **If a real Owner
account is ever found with a non-null `collegeId`, every campus-scoped query
in the app will incorrectly treat them as scoped to one campus.** One-line
fix if it ever happens: `UPDATE "Staff" SET "collegeId" = NULL WHERE role = 4;`
— verify with `SELECT phone, name, role, "collegeId" FROM "Staff" WHERE role = 4;`
first.

## Audit log — 2026-09 sessions

A running list of real bugs found and fixed, so the same class of bug isn't
rediscovered from zero next time. Full detail is in git history; this is the
index.

**Security / authorization (IDOR-class — missing `assertSameCollege` or
missing ownership check):**
- `submitComplaint` — no ownership check on a caller-supplied `orderId`
- `eraseStudentData`, `saveSlotWindow`/`toggleSlotWindow`/`deleteSlotWindow` — missing campus check
- `college-statement`/`xlsx` exports, `import/students`, `receipt` route, `invoice/[orderId]` export — missing campus check
- `topUpCredits` — missing campus check
- **7 server-component pages (see above)** — the big one, 2026-09-05

**Concurrency / races (lost-update, missing row locks):**
- `collectOrder`, `refundOrder`, `sellCyclePack`/`assignSubscription`/`upgradeSubscription`,
  `issueBag`, `grantFreeReservice`, `adjustCycleUsage`, `retireBag`,
  `flushSheetOutbox`, `rate-limit.ts` — all needed `SELECT ... FOR UPDATE`
  inside a transaction, or an atomic `updateMany` + count-check, instead of a
  read-then-write.
- Lesson: a `SELECT ... FOR UPDATE` only holds its lock for the life of the
  `$transaction()` callback it's inside — a bare `$queryRaw` outside a
  transaction commits and releases immediately. Caught mid-implementation
  once (`flushSheetOutbox`) before shipping it.
- Lesson: raw SQL (`$queryRaw`/`$executeRaw`) does NOT automatically respect
  a Postgres connection's `?schema=...` param the way Prisma's ORM methods
  do — it hits the connection's default `search_path`. Fixed via
  `dbSchemaPrefix` (`lib/db.ts`) + `Prisma.raw()` to schema-qualify raw table
  references.

**Order lifecycle:**
- `collectOrder` never checked the order was actually `status: "ready"` —
  every other transition enforces its starting state explicitly, this one
  didn't.
- `redoOrder` had no starting-state check at all.

**Money:**
- `financialYearTag()` used server-local UTC instead of IST — orders paid in
  the ~5.5h window after midnight IST on April 1 got the previous year's
  invoice sequence. Fixed to shift into IST first (same pattern as
  `istToday()` in `lib/actions/ops.ts`).
- `createPayslip` had no uniqueness guard on (staffId, month) — a
  double-submit could double-pay someone. App-level P2002 catch shipped; the
  DB-level `@@unique([staffId, month])` constraint is deliberately NOT yet
  added — `prisma db push` refused it because production may already have
  duplicate rows. **Do not force `--accept-data-loss` on payroll data without
  running the duplicate-check query first** (see below).

**Reliability / UI:**
- OTP compare used `!==` instead of `crypto.timingSafeEqual` (timing attack).
- Several client components could get stuck showing "Saving…"/"Sending…"
  forever on a thrown error (missing try/catch, or `finally` with no
  `catch`) — `ReportsClient`, `HelpClient`, others.
- The offline-queue (`lib/offline-queue.ts` + `components/offline.tsx`) lost
  the `cycles` field on replay — a cycle-based walk-in captured offline
  silently defaulted to 1 cycle once the connection returned.
- Service worker's offline navigation fallback bounced staff/customers to
  the marketing homepage instead of their own app shell.
- CSP had no `worker-src`, silently blocking Sentry's Web Worker (found via
  a live browser console check on the deployed site, not from reading code —
  a reminder that some bugs only show up by actually loading the page).

**Accessibility:**
- The `Sheet` component (used for every modal/bottom-sheet app-wide) had no
  `role="dialog"`/`aria-modal`, no focus management, no Escape handler.
- Light-theme `--muted`/`--faint` text failed WCAG AA contrast (4.05:1 and
  2.47:1 against a 4.5:1 requirement) — darkened to 5.2:1+/4.2:1+.

## Known edge case (not a leak, opposite risk)

`Complaint.collegeId` has `@default("")` in the schema. The new
campus-scoping filters (`app/s/page.tsx`, `app/s/complaints/page.tsx`) do
`where: { collegeId: staff.collegeId }`, which will never match a row whose
`collegeId` is still the empty-string default. Any such legacy row would
silently vanish from a scoped staffer's complaint list — not a cross-campus
leak (the opposite: legitimate same-campus data going invisible). One query
answers whether this is live: `SELECT count(*) FROM "Complaint" WHERE
"collegeId" = '';`. If non-zero, backfill those rows' real `collegeId` from
their student's campus.

## Pending / needs a human check

- **Payslip duplicate-check** — before adding `@@unique([staffId, month])`
  back to `prisma/schema.prisma`, run in Supabase SQL Editor:
  ```sql
  SELECT "staffId", month, count(*), array_agg(number) AS payslip_numbers
  FROM "Payslip" GROUP BY "staffId", month HAVING count(*) > 1;
  ```
  Empty result → safe to add the constraint and redeploy. Non-empty → decide
  per-row which payslip is correct before touching the schema.
- **Owner collegeId check** — see above, one query confirms it, one query
  fixes it if wrong.

## Deploy conventions this project actually uses

- Push to `main` AND `main:render-migration` — Render (primary, cheaper,
  runs both app + DB) auto-deploys from `render-migration`; Vercel deploys
  via `npx vercel --prod --yes` and stays aliased to `fabricfold.in` as a
  secondary/parallel deployment.
- `npm run build` runs `prisma db push` against whatever `DATABASE_URL` is
  set locally — **check `.env` before running a local build**; at various
  points this session it pointed at the old Sydney rollback-only project,
  not live production. Production's real schema sync happens inside the
  Vercel/Render build itself, using their own env vars — a local build never
  touches live production data.
- `prisma db push` refuses (correctly) to apply a change that risks data
  loss — e.g. a new unique constraint over existing duplicate rows. When
  this happens: the build fails, the previous deployment stays live (safe),
  and the fix is to investigate the real data, not to add
  `--accept-data-loss` reflexively.
- CI (`.github/workflows/test.yml`) runs typecheck + the full test suite
  against an ephemeral Postgres service container — never touches
  production. Added 2026-09-04; its first run failed because `prisma db
  push` doesn't take `--skip-generate` in Prisma 7 (fixed same day).
- Sentry is wired (both platforms have `NEXT_PUBLIC_SENTRY_DSN` set as of
  2026-09-04) and confirmed genuinely working via a live triggered error in
  the browser (tunneled through same-origin `/monitoring-tunnel`, so CSP's
  `connect-src` was never actually a concern — only `worker-src` was).

## Live-testing constraints (why some things stay code-verified only)

Production has no test-OTP bypass (`TEST_TOOLS` env var is unset on both
platforms, `TEST_PHONES`/`DEV_OTP` likewise) — real login requires a real
WhatsApp-delivered OTP. Enabling either of those in production, even
temporarily, is a production-auth-config change and gets (correctly) blocked
by the safety classifier without explicit human action. Practical
consequence: end-to-end login flows across roles/colleges can't be
self-tested by an agent session without either (a) the account owner pasting
a real OTP as it arrives, or (b) the account owner doing the click-through
verification themselves. Code-level fixes are verified via the test suite
(`npm test`) and, where practical, a live *unauthenticated* browser check
(console errors, CSP headers, page rendering) — this catches real bugs (the
CSP `worker-src` gap was found exactly this way) without needing a session.
