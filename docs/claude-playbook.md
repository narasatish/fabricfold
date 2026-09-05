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
- **Payslip duplicates**: zero `(staffId, month)` duplicates found. The
  `@@unique([staffId, month])` constraint has been added back to
  `prisma/schema.prisma` and is now live.
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
