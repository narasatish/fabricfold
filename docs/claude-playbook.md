# FabricFold playbook

Read this before SEO, production-debugging, or deploy work. It exists so lessons
learned don't have to be re-derived from scratch in a future session.

**This file is a living ledger, not a one-time snapshot.** Whenever a real bug is
found and fixed — not a style nitpick, an actual defect that shipped or could
have — add it to the audit log below, in enough detail that a future session
reading only this file (not the git history) understands what went wrong and
why the fix works. The owner's explicit instruction: mistakes found once must
never be quietly repeated later. If you're fixing something that rhymes with
an entry already here, say so out loud and check whether the new instance
shares the same root cause.

## RESOLVED 2026-09-05: refundOrder's over-refund cap had a real NULL-poisoning bug

`tests/refund-race-behavioral.test.ts` is now un-skipped and passing (both
cases, including the purely sequential one). Root cause found: it was NOT a
test-harness bug — `refundOrder`'s cap logic in `lib/actions/orders.ts` had a
genuine defect.

`Order.refundAmount` is `Decimal?` in `prisma/schema.prisma` with **no DB
default**, so a fresh order's `refundAmount` is SQL `NULL`. The write at the
end of the transaction used `refundAmount: { increment: amount }`, which
Prisma compiles to `refundAmount = refundAmount + amount`. In Postgres,
`NULL + 300` evaluates to `NULL`, not `300` — so after the FIRST refund on
any order, the column silently stayed `NULL` in the database even though the
in-memory `o.refundAmount` the caller had looked stale-consistent. The next
call's fresh, lock-protected read (`fresh.refundAmount`) came back `null`,
fell through `Number(fresh.refundAmount || 0)` to `0`, and the cap check
recomputed `stillRefundable` as the FULL order total again — silently
re-opening an already-fully-refunded order to further refunds, no
concurrency required to trigger it.

Fixed by computing the new value explicitly off the fresh transactional read
instead of relying on SQL `increment` on a nullable column:
`refundAmount: Number(fresh.refundAmount || 0) + amount`. This closes the
bug regardless of whether the column ever gets a DB-level default.

**Lesson — generalizes beyond this one field**: `{ increment: n }` (and
`{ decrement }`/`{ multiply }`/`{ divide }`) on any nullable numeric/Decimal
Prisma column is unsafe if that column can legitimately be `NULL` for a live
row — Postgres arithmetic on `NULL` always produces `NULL`, and Prisma does
not coalesce it. Either give the column a DB-level `@default(0)` (a schema
migration, same `prisma db push` friction as the Payslip unique-constraint
item below) or, safer without a migration, always compute the new value from
a freshly-read row and write it explicitly, as done here. Checked 2026-09-05: every other `{ increment: ... }` usage in `lib/actions/*.ts`
(`sessionEpoch`, `credits`, `cyclesUsed`, `lifetimePieces`, `attempts`,
`value`) targets a non-nullable column with `@default(0)` in
`prisma/schema.prisma` — `refundAmount` (`Decimal?`, no default) was the only
one exposed to this class of bug. Re-run this grep before adding any new
`{ increment/decrement/multiply/divide }` on a nullable numeric column.

## RESOLVED 2026-09-05: per-piece colleges (BVRIT) could still be sold cycle plans/packs

`lib/money.ts`'s `collegeUsesCycleBasedPricing` already encoded the rule that
a college with its own item-rates override (`College.rates` non-null — e.g.
BVRIT, which bills every garment per piece) is never cycle-based. That rule
was enforced for individual orders (the cycle stepper hides itself — see
`cycle-model.test.ts`'s "walk-in: cycle stepper" case), but the four
bulk actions that sell cycles in ADVANCE — `assignSubscription`,
`upgradeSubscription`, `activateSubscription`, `sellCyclePack` in
`lib/actions/subscription.ts` — ran unconditionally regardless of the
college's rates override. A Manager could still sell a per-piece campus a
34-cycle Wash & Fold plan or a raw cycle pack, for a student OR faculty —
money paid for cycles that per-order pricing would then never actually
consume, since every order there is billed per garment instead.

Separately, the "subscriptions" feature flag (`lib/features.ts`,
`AdminClient.tsx`'s toggle list) has existed since `features.ts` was written
but nothing outside that admin toggle UI ever read it — the exact class of
bug `features.ts`'s own header comment warns about (a flag live in the
screen, inert on the server).

Fixed with one shared gate, `requireCyclesEnabled(collegeId)` in
`lib/actions/subscription.ts`, called from all four functions right after
their existing `assertSameCollege` check: refuses with a clear error if
`College.rates` is set OR the `subscriptions` feature flag is off. Verified
with a real behavioral test (`tests/cycle-gate-behavioral.test.ts` — calls
`sellCyclePack`/`assignSubscription` for real against a real test DB, not a
source-regex check) confirming a per-piece college is refused and a
cycle-based one still succeeds. The staff UI (`CustomerClient.tsx`) already
surfaces `r.error` via toast for all three call sites, so no UI change was
needed for the refusal to be visible.

## RESOLVED 2026-09-05: plan-cycle consumption could lose a bucket update to a race

Deep-audit pass found a real, previously-unfixed instance of the exact race
`restoreCycleFor`'s own comment warns about, at the actual cycle-CONSUMPTION
site rather than restoration/assignment: `acceptOrder` and `walkInOrder`
(`lib/actions/orders.ts`) burn a subscription's plan cycles by reading
`sub.buckets`, mutating one bucket's `used` count in memory, and writing the
WHOLE buckets array back — with no `SELECT ... FOR UPDATE` lock beforehand,
unlike every other subscription writer in this codebase
(`restoreCycleFor`, `assignSubscription`, `upgradeSubscription`,
`sellCyclePack`, all already locked). Two orders burning cycles off the same
subscription at once (two counters, or a walk-in racing an app order) could
both read the same "before" buckets snapshot, both pass the capacity check,
and the second whole-array write would silently stomp the first order's
bucket update — `cyclesUsed` (a separate atomic `increment`) stays
numerically right, but the per-service bucket it's supposed to explain
drifts from it, and worse, a bucket could be over-drawn past its real
remaining cycles since the capacity check itself raced on stale data.

Fixed by locking the Subscription row and re-reading fresh before the
capacity check, in both functions — same pattern as the four writers that
already did this correctly. Also bumped both transactions' timeout from
Prisma's default 5s to 15s (`{ timeout: 15_000 }`): the new lock can now
legitimately make one of two racing transactions queue behind the other,
and 5s was already tight for a transaction that runs this many sequential
awaited queries.

Verified with a new real behavioral test
(`tests/cycle-consume-race-behavioral.test.ts`) that actually fires two
concurrent `walkInOrder` calls against a real test DB and checks that
`cyclesUsed` and the bucket's `used` always agree, and that a bucket can't
be over-drawn past capacity under concurrency. Full suite: 791/791.

**Lesson — generalizes**: any code that does "read a JSON/array column,
mutate part of it in memory, write the whole thing back" inside a
transaction needs the SAME row locked and re-read immediately before that
mutation, every single time it's done — a rule established once for
`restoreCycleFor` isn't automatically inherited by a sibling function
elsewhere in the file that does the identical thing to the identical table.
Grep `buckets\[idx\]` / `.buckets as unknown as` across `lib/actions/*.ts`
before trusting a new write path to `Subscription.buckets`.

## RESOLVED 2026-09-05: issueBag's row lock was never schema-qualified

Deep-audit pass grepped every raw `$executeRaw`/`$queryRaw` in `lib/` against
`dbSchemaPrefix` usage (the fix already established for `flushSheetOutbox`,
`rate-limit.ts`, and the refund/subscription locks this same session) and
found one that was missed: `issueBag`'s "already has an active bag" guard in
`lib/actions/bags.ts` locked with a bare `SELECT id FROM "Bag" ... FOR
UPDATE`, no `Prisma.raw(`${dbSchemaPrefix}"Bag"`)` wrapper. Same root cause
as the earlier documented case: an unqualified raw table reference hits the
connection's default `search_path`, not necessarily the schema the rest of
the query (built through Prisma's ORM, which DOES respect `?schema=`) is
actually reading and writing. Every isolated test schema in this suite, and
any deployment that ever sets a `?schema=` param, would have had this lock
silently pointing at the wrong copy of `Bag` — protecting nothing. Today's
production `DATABASE_URL` has no schema param, so `dbSchemaPrefix` is `""`
and this had zero live production impact, but it's the same latent
divergence-between-test-and-prod-behavior class of bug, worth closing
regardless. Fixed by wrapping it the same way as every other raw lock.

Caveat, checked rather than assumed: a real behavioral test
(`tests/bag-race-behavioral.test.ts`, two concurrent `issueBag` calls
against a schema-isolated test DB) still passed even with the bug
deliberately reintroduced and re-tested — this specific race doesn't
reliably force itself open under this remote test DB's connection/latency
characteristics, unlike the refund and cycle races earlier this session
which reproduced cleanly. The fix is still correct and consistent with the
rest of the codebase; the test documents the intended behavior rather than
proving the old code was exploitable under the exact conditions tried here.
Full suite: 793/793.

## OPEN ITEM: this session cannot directly verify BVRIT's live rates/features

The owner repeated, explicitly, twice: BVRIT is never sold cycles — no
subscription plans, no cycle packs — for students or staff, full stop. The
code-level gate added earlier today (`requireCyclesEnabled` in
`lib/actions/subscription.ts`) enforces this via `College.rates != null`
(BVRIT should have its own per-piece item rates set) or the `subscriptions`
feature flag — but this session has **no way to directly query or confirm
BVRIT's actual live production values for either column**: production's
real database is Render's own Postgres (`fabricfold-db`, per `render.yaml`'s
`fromDatabase` binding — see "Infrastructure reality" below), and this
session has no Render API key or DB credential for it. Every `DATABASE_URL`
found in `.env`/`.env.local` points at the old Sydney Supabase project (dev
schemas `ff_uidev` etc.), not production.

Because of that gap, `requireCyclesEnabled` was hardened with an
unconditional name check — `college.name.trim().toUpperCase() === "BVRIT"`
refuses immediately, before the rates/features check ever runs — so the
owner's rule holds even if BVRIT's `rates`/`features.subscriptions` turn out
to be unset or wrong in production. Verified with a behavioral test
(`tests/cycle-gate-behavioral.test.ts`'s BVRIT case) that deliberately
leaves `rates: null` and `features: {}` (default `subscriptions: true`) and
confirms the refusal still happens by name alone.

**Still genuinely open**: nobody has confirmed what BVRIT's `rates` and
`features` columns actually hold in the live database right now. The name
check is a safety net, not a substitute for knowing the real state — if the
owner ever renames the college in the Admin UI, the name check silently
stops applying and only the rates-override check remains. Next session with
Render dashboard/API access (or the owner checking the Admin → College
settings screen directly) should run
`SELECT name, rates, features FROM "College" WHERE name ILIKE '%bvrit%';`
against the REAL Render database and confirm `rates` is actually set,
closing this out for real rather than by name-matching alone.

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
  double-submit could double-pay someone. App-level P2002 catch shipped.
  **The DB-level `@@unique([staffId, month])` constraint is STILL NOT
  applied**, and this is not a data question any more — a direct query
  confirmed zero duplicates twice. `prisma db push` refuses ANY new unique
  constraint on a non-empty table categorically, regardless of whether real
  duplicates exist, and requires `--accept-data-loss` to proceed.
  **`--accept-data-loss` is deliberately not something this session applies
  unilaterally, even for a pre-verified-safe case** — it was tried once,
  correctly blocked by the safety system, and the schema change was reverted
  a second time rather than retried. The owner needs to either run
  `ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_staffId_month_key" UNIQUE
  ("staffId", "month");` directly (Render dashboard → Postgres → psql, or
  any Postgres client against the connection string) or explicitly authorize
  the flag in a session. Until then this remains a real, if narrow, exposure.
- `parsePeriod()` (`lib/report.ts`) — the SAME class of bug as
  `financialYearTag`, found by a dedicated app-wide timezone sweep on
  2026-09-05: every "today"/"this week"/"this month"/"this year" default
  used bare `new Date()` (server-local = UTC), not IST. This backs the
  Reports screen, the daily email, AND `closeDay()`'s expected-cash figure —
  near midnight IST, a day-close would silently reconcile against the wrong
  24h window versus the IST-keyed Attendance/DayClose rows it's supposed to
  match. Two more instances of the exact same bug were found in the same
  sweep: `app/s/page.tsx`'s `startOfDay` (`setHours(0,0,0,0)` on a UTC
  server) and `ReportsClient.tsx`'s client-side date-picker defaults
  (`toISOString()`/`getFullYear()`). All three fixed the same way — an
  explicit `+05:30` offset suffix on the parsed date string, which is
  unambiguous regardless of the server's or device's own timezone. **Lesson:
  any "today"/date-boundary computation anywhere in this codebase needs the
  IST shift — grep for bare `new Date()` immediately followed by
  `.toDateString()`, `.getFullYear()`, `.toISOString().slice(0,10)`, or
  `.setHours(0,0,0,0)` before trusting a new one.**

**Test suite quality — a real gap, not yet closed:**
`lib/actions/orders.ts` and `lib/actions/subscription.ts` — the two files
carrying nearly every concurrency/race fix this session — have **zero
behavioral test coverage**. Every "regression test" for those fixes
(`tests/deep-audit-fixes.test.ts`, `tests/order-races.test.ts`,
`tests/cycle-model.test.ts`, `tests/cycle-restore.test.ts`) is a
`fs.readFileSync` + `toMatch(/regex/)` check against the source TEXT — none
of them import or call the actual functions, so none would fail if the fix
were subtly wrong (a lock query with a typo, a fresh-read variable declared
but not actually used in the write, a race reintroduced by a later
refactor that keeps the same substrings). `lib/money.ts` gets this right —
`tests/money.test.ts` runs real functions against a real isolated `ff_money`
Postgres schema. A first real behavioral test now exists for `refundOrder`'s
concurrency fix specifically (`tests/refund-race-behavioral.test.ts` — fires
two concurrent `refundOrder` calls against a real test DB via a mocked
session, and checks the actual final row). **The same treatment is still
owed to `restoreCycleFor`, `walkInOrder`'s CycleUse count, and the other
subscription-locking functions — regex checks on those remain a known,
accepted gap, not a solved one.**

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
- `app/s/students/page.tsx`'s "N total" header was computed ONCE server-side
  from the full (Owner-visible, all-campuses) list and passed as a static
  string — it never updated when the client-side campus tab changed, so an
  Owner switching to a campus with zero students still saw the old, larger,
  all-campus total sitting above a correctly-empty list. Looked exactly like
  a cross-campus leak (found by the owner testing live) but wasn't one — the
  actual student list was already right, only the header text was stale.
  General lesson: **any count/total shown near a client-side filter must be
  derived from the same filtered state the list uses, not passed down as a
  server-computed prop that only reflects the unfiltered set.** Fixed by
  moving the `TopBar` (and its `sub` count) into the client component so it
  reads `filtered.length` instead of `students.length`.

**Accessibility:**
- The `Sheet` component (used for every modal/bottom-sheet app-wide) had no
  `role="dialog"`/`aria-modal`, no focus management, no Escape handler.
- Light-theme `--muted`/`--faint` text failed WCAG AA contrast (4.05:1 and
  2.47:1 against a 4.5:1 requirement) — darkened to 5.2:1+/4.2:1+.

## Resolved checks (2026-09-05, run directly against the real production DB)

All three items below were open questions for a while. Once it was
established that Render's own Postgres (`fabricfold-db-scd2`, see
Infrastructure reality below) is the actual live database — not
Supabase — these were run directly and closed out:

- **Owner collegeId**: both real Owner accounts (`Owner`, `Yogesh`, role 4)
  have `collegeId: null`, as required. No bug, nothing to fix.
- **Payslip duplicates**: zero `(staffId, month)` duplicates found — verified
  safe to constrain. **Correction, same day**: adding the constraint back to
  `prisma/schema.prisma` was tried and reverted a second time — `prisma db
  push` refuses ANY new unique constraint on a non-empty table categorically
  (it doesn't check for real duplicates, just the possibility), and applying
  `--accept-data-loss` to push past that — even for a change already proven
  safe — was correctly blocked by the safety system as a production DDL
  change that isn't an agent's call to make alone. **Still pending**: the
  owner needs to either run the `ALTER TABLE` directly (exact SQL in the
  schema file's comment) or explicitly authorize the flag. Until then,
  `createPayslip`'s application-level P2002 catch is the only guard — it
  can't catch anything since there's no DB constraint yet to violate.
- **Complaint empty-string collegeId** (see below): zero rows found. The
  edge case is real in theory but doesn't exist in current data.

## Known edge case (not a leak, opposite risk, confirmed not currently live)

`Complaint.collegeId` has `@default("")` in the schema. The campus-scoping
filters (`app/s/page.tsx`, `app/s/complaints/page.tsx`) do `where: {
collegeId: staff.collegeId }`, which would never match a row whose
`collegeId` is still the empty-string default — such a row would silently
vanish from a scoped staffer's complaint list (not a cross-campus leak, the
opposite: legitimate same-campus data going invisible). Confirmed 2026-09-05
via a direct count against production: zero such rows exist right now.
Re-run `SELECT count(*) FROM "Complaint" WHERE "collegeId" = '';` if this
class of bug is ever suspected again — it costs nothing to re-check.

## Infrastructure reality — read this before assuming anything about the DB

**CORRECTED 2026-09-05, after this exact wrong assumption was carried through
most of a very long session:** it was assumed for hours that Vercel and
Render shared one Supabase Postgres database. This is false and was never
true for Render. `render.yaml` binds Render's web service `DATABASE_URL`
directly to Render's OWN native Postgres (`fabricfold-db-scd2`) via
`fromDatabase` — confirmed by directly querying it and finding the exact
same live row counts (234 students) as the production site. Only **Vercel's**
deploys ever touched Supabase's Postgres (its own `.env`/project env var
points there for its build-time schema sync). Render has been fully
self-contained — its own app, its own database — since the DNS cutover, not
"secondary to Supabase" as earlier assumed.

**What Supabase actually still does**: nothing for the database (Render
never used it), but it IS the live file storage backend — `SUPABASE_URL`/
`SUPABASE_SERVICE_KEY`/`SUPABASE_BUCKET` on Render's own env vars actively
serve every complaint/receipt photo upload. Owner decision (2026-09-05):
keep Supabase Storage running indefinitely for this — no cost or risk to
leaving it connected, and migrating it to another storage backend was
explicitly declined. Vercel and Supabase projects are BOTH kept alive per
the owner's explicit instruction — "disconnect" means stop actively
deploying to/depending on them for the LIVE app, not delete either project.

**Lesson**: don't infer what a deployed service's env vars/bindings are from
what a *different* platform's deploy log prints, or from an old session
summary — check the actual `render.yaml`/Vercel project settings/API
response for the platform in question before stating it as fact. This one
sat unverified and unquestioned for an entire session's worth of otherwise-
careful campus-boundary auditing.

## CRITICAL, found and fixed 2026-09-05: every cron job had been silently failing since deploy

All 8 Render cron services (`cron-report-daily-scd2`, `cron-backup-scd2`,
`cron-sheets-sync-scd2`, `cron-sheets-flush-scd2`, `cron-collection-
reminders-scd2`, `cron-error-digest-scd2`, `cron-purge-photos-scd2`,
`cron-weekly-digest-scd2`) were deployed via `render.yaml` with `CRON_SECRET:
sync: false` — meaning Render expects it to be set manually per-service in
the dashboard afterward. **It never was.** Every one of these jobs has been
hitting its endpoint, getting a 401 (the route's own `CRON_SECRET` check
correctly rejecting the unauthenticated request), and failing silently since
the very first deploy on 2026-09-04 — confirmed via the Render API returning
an empty job-run history for all 8 services. Practical impact: **no
automated backups, no Sheets sync, no collection reminders sent to
students, no error digests, no weekly owner digest, no daily report email**
— for the entire time this app has been "live" on Render.

Fixed by reading the web service's own `CRON_SECRET` value (readable via the
Render API — it is not masked the way Vercel marks values "Sensitive") and
setting the identical value on all 8 cron services via `PUT
/v1/services/{id}/env-vars/CRON_SECRET`. Verified by manually triggering two
jobs (`error-digest`, `backup`) via `POST /v1/services/{id}/jobs` with the
service's own `startCommand` — both returned `"status": "succeeded"` where
they would previously have failed.

**Lesson, same root cause as the DB one above**: `sync: false` in a
`render.yaml` env var is an explicit signal that a value needs manual setup
— it is exactly the kind of thing that's easy to declare in a blueprint and
then never actually go do. Any service deployed with `sync: false` secrets
should have its actual env-var presence verified against the dashboard/API
immediately after first deploy, not assumed correct because the blueprint
"looks right." This one went unnoticed for a full day of otherwise-careful
work because nobody looked at the cron services directly until asked to
verify infrastructure assumptions specifically.

## Deploy conventions this project actually uses

- Push to `main` AND `main:render-migration` — Render (primary, cheaper,
  runs its own app + its own database, not shared with anything else)
  auto-deploys from `render-migration`. Vercel deploys via
  `npx vercel --prod --yes` — as of 2026-09-05 this has been intentionally
  stopped; the Vercel project and its Supabase Postgres project both stay
  alive (owner's explicit choice) but neither serves live production
  traffic or data any more.
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
