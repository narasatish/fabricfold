# FabricFold playbook

## RESOLVED 2026-10-21: rate-limiting/CSRF/perms/session-revocation sweep — one real gap found, `POST /api/report/daily` ignored the "reports" tool revocation

Scoped re-sweep of the four areas the owner wanted re-verified, continuing
today's permission-matrix work (`refundOrder`/`redoOrder`/
`grantFreeReservice` → `requireStaffPerm("refunds")`, documented above).

**Real bug found: `POST /api/report/daily` ("Email today's report" button
on the Reports screen) checked `requireStaff(2)` — a bare role floor — not
the "reports" tool.** `app/s/reports/page.tsx` itself correctly gates the
whole Reports screen on `staffCan(me, "reports")` before rendering, and its
sibling `app/api/export/xlsx/route.ts` correctly calls
`requireStaffPerm("reports")` on the API side too — the standard this
codebase holds every other staff-gated action to ("client-side hiding was
never a wall"). `report/daily`'s route never got that second check: a
Manager (role 2, which clears `requireStaff(2)` on its own) whose "reports"
tool the owner explicitly revoked was correctly bounced from the Reports
page UI, but could still `POST` directly to `/api/report/daily`, trigger
the real owner-report email send, and read back the configured report
destination address in the JSON response — exactly the "money reports &
exports" category (lib/perms.ts: "Revenue, GST, drawer figures, Excel
downloads") the "reports" tool exists to gate, bypassed by skipping the
page and hitting the route directly. Fixed by swapping `requireStaff(2)`
for `requireStaffPerm("reports")` in `app/api/report/daily/route.ts`'s
`POST` handler (the cron `GET` handler is unaffected — it's already gated
on the separate `CRON_SECRET` Bearer check via `isCronRequest`). New test:
`tests/report-daily-perm-behavioral.test.ts` — a Manager with `reports:
false` gets a 401 from the route directly, a Manager with the default
(granted) "reports" access gets 200, and a Counter member (role 1, below
the tool's own floor) gets 401. Confirmed it failed pre-fix (200 instead of
401) and passed post-fix; mutation-tested (reverted to `requireStaff(2)`,
confirmed the revoked-Manager case failed again, restored the fix).

**Everything else in this round's scope checked out, no changes needed:**
- **Rate limiting** (`lib/rate-limit.ts` + every unauthenticated action in
  `lib/actions/auth.ts`, `wa-login.ts`, `wa-register.ts`): `requestOtp`,
  `startWhatsAppLogin`, `startWhatsAppRegister`, `hasPasscode`,
  `loginWithPasscode`, `createPasswordWithCustomerId` all cap by IP (and
  `requestOtp` also by phone number); `verifyOtp`/`checkWhatsAppLogin`/
  `checkWhatsAppRegister` rely on a self-limiting per-code attempt counter
  (5 wrong tries burns the code) rather than a separate IP cap, which is
  the same defense `requestOtp`'s own rate limit exists to back up, not a
  gap. `loginWithPasscode`'s per-account lockout is already locked
  row-then-fresh-recheck (a prior fix, re-verified intact) so parallel
  guesses can't bypass the 5-attempt cap by racing it.
- **CSRF / cookie-only mutation via cross-site GET**: every `app/api/*`
  route whose `GET` handler could mutate state is gated by either
  `isCronRequest`/`authorised` (the `CRON_SECRET` Bearer check, immune to a
  browser navigation carrying cookies) or `requireStaff`/`requireStudent`
  session checks on a read-only download (receipt, invoice, statement,
  xlsx, college-statement) — none of those perform a write from a plain
  `GET`, so the session cookie's `sameSite: "lax"` (which already exempts
  only top-level, "safe"-method navigations) can't be abused into a
  state-changing cross-site request. No API route takes a state-mutating
  action on `GET`.
- **Staff permission matrix**: besides the `report/daily` fix above, swept
  every `PermKey` (`reports`, `refunds`, `dayclose`) against every server
  action and route that touches that category. `refunds` already fully
  covered (`refundOrder`, `redoOrder`, `grantFreeReservice`,
  `submitCompensation`, per the audit documented above). `dayclose` has
  exactly one action (`closeDay`), already gated. `app/api/export/
  college-statement/route.ts` and `lib/actions/cash.ts`'s
  `recordCashCount` use a bare `requireStaff(3)` role floor rather than a
  `PermKey`, but that is an intentional, already-documented design choice
  (both live inside the Admin-only `/s/admin` section the owner scoped by
  role, same bucket as `saveRates`/`savePaymentConfig`/`saveStaff`, not the
  three explicitly-revocable money tools) — left alone. `requireStaff`/
  `requireStaffPerm` both re-read the Staff row from the database on every
  call (no caching from the session token), confirmed by `tests/
  route-guards.test.ts`'s existing assertion and re-verified by reading
  `lib/auth.ts` directly — a permission the owner revokes takes effect on
  the very next request, not at the token's 365-day natural expiry.
- **Session revocation**: `requireStudent`/`requireStaff` are the only two
  checkpoints in the codebase that mint a trusted session, and every newer
  route added in today's other audits routes through one of them —
  `confirmGatewayPayment`/`createGatewayOrder` (`lib/actions/payments.ts`)
  via `requireStudent()`, `broadcastNotice` (`lib/actions/students.ts`) via
  `requireStaff(2)` — so the `sessionEpoch`/`active` re-check already
  covers them; no new bypass found alongside the 7-route fix documented
  above (`lib/cron-auth.ts`, 2026-10-20).

`npm test`: 1224/1224 (1223 + the 1 new test), with the pre-existing
`tests/upgrade-subscription-race-behavioral.test.ts` flake reproduced once
under full parallel load and confirmed passing in isolation, same as every
prior round. `npx tsc --noEmit` clean.

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

## RESOLVED 2026-10-21: collection-reminders cron could double-send the same "please collect it" nudge on an overlapping concurrent run

Scoped audit of render.yaml's full cron list (cron-report-daily, cron-backup,
cron-sheets-sync, cron-sheets-flush, cron-purge-photos,
cron-collection-reminders, cron-error-digest, cron-weekly-digest,
cron-uptime-watchdog) for idempotency under overlapping runs, auth strength
(`isCronRequest`/`isCronOrStaff`), and honest partial-failure reporting — not
re-covering the cron-sheets-sync 429 fix or the cron-watchdog removal, both
already closed out in earlier 2026-10-20 entries.

**Real bug found:** `app/api/cron/collection-reminders/route.ts` reads an
order's `collectionRemindersSent` counter, decides whether the 24h/48h nudge
is due, calls `pushNotif`, and only THEN increments the counter — three
separate steps with nothing holding the row between them. The field's own
comment says it exists specifically so this cron "can't re-send the same
nudge every run while a bag sits there" — but that only protects against
successive runs, not two runs overlapping in time (a slow run plus a retry,
the same class of overlap `cron-report-daily` and `weekly-digest` already
guard against with a timestamp check, just via a different mechanism). Two
runs racing on the same order both read `collectionRemindersSent` before
either had written its increment, both independently decided the nudge was
due, and both called `pushNotif` — the counter still ends up correct
(incremented twice), so nothing downstream would ever notice, but the
student gets the same "please collect it" notification twice for one event.

**Fix:** claim the increment BEFORE sending, not after — the same
"claim via `updateMany` count" pattern already used in this codebase for
`waVerify` (lib/actions/wa-login.ts) and `complaint.redoOrderId`
(lib/actions/complaints.ts). `db.order.updateMany({ where: { id,
collectionRemindersSent: <value just read> }, data: { increment: 1 } })` —
only the run that still sees the stale value gets `count === 1` and proceeds
to send; a losing concurrent run sees `count === 0` and skips. Safe because
`pushNotif` already swallows and ErrorLog-records its own failures
internally (lib/notify.ts) rather than throwing, so claiming first never
risks losing a send to an uncaught push error.

Behavioral test: `tests/collection-reminders-race-behavioral.test.ts` (real
Postgres, isolated `ff_collection_reminders_race` schema) mocks `pushNotif`
with a deliberate delay (modeling a real push round trip) and fires the
route's `GET` handler twice concurrently against one order whose ready-event
is 25h old; asserts exactly one `pushNotif` call and a final counter of 1.
Confirmed it fails (2 calls) without the fix, passes with it; mutation-tested
(stashed the fix, confirmed the test fails again with the exact same
assertion, restored it).

Everything else checked in this pass was already sound, no changes made:
- **Auth:** every cron route in render.yaml uses `isCronRequest` or
  `isCronOrStaff` (both backed by the timing-safe `CRON_SECRET` check) — none
  use a weaker check.
- **cron-sheets-sync / cron-sheets-flush:** `runSheetsSync` and
  `flushSheetOutbox` already report partial failure honestly (prior pass,
  `tests/sheets-error-handling.test.ts`); `/api/sheets/flush` is
  append-only/idempotent by construction (rows marked sent only once Google
  accepts them).
- **cron-purge-photos:** per-row try/photo-delete with its own
  deleted/failed counters, disputed complaints/orders excluded from deletion
  regardless of age — re-running it is a no-op for anything already purged
  (keys already cleared to `DbNull`).
- **cron-error-digest:** queries `ErrorLog` by `seen: false` only — no date
  range, so a scoping/date-window bug that could silently report "0 errors"
  while rows exist isn't present. Cross-checked that `lib/push.ts` and
  `lib/notify.ts`'s own failure logging (fixed earlier the same day) writes
  rows with `kind: "client"` and no `seen: true`, so those failures do surface
  in this digest. Marks rows seen only AFTER the mail send succeeds, so a
  send failure correctly means the next run re-reports them rather than
  losing them.
- **cron-weekly-digest / cron-report-daily:** both already have a
  `lastSent`-timestamp guard against a retried trigger double-emailing the
  owner within the same window (both call out collection-reminders'
  `collectionRemindersSent` guard in their own comments as the precedent —
  ironic given the gap just fixed above, but the two mechanisms protect
  against different things: a timestamp guard stops re-firing on a *later*
  retry of the whole job, not two *simultaneous* runs each individually
  deciding per-row whether to act, which is exactly why
  collection-reminders needed the per-row claim instead).
- **"5+ days" bags-waiting figures** (staff dashboard `HomeClient.tsx`,
  weekly-digest): both use a rolling `Date.now() - readyAt > 5 * 86_400_000`
  window, not a calendar-day boundary — consistent with each other and not
  actually claiming day-boundary semantics anywhere, so this is not the same
  bug class as the UTC-vs-IST calendar-day bugs documented elsewhere in this
  file (those are about a *calendar day* label, e.g. month/FY rollover;
  "has this been sitting for more than N hours" is correctly hour-based).
- **cron-backup / cron-report-daily:** backups are additive/timestamped
  (never overwritten) and the daily report's `lastSent` guard is scoped to
  the cron path only, so the manual "Email today's report" button is never
  silently swallowed.

`npm test`: 1224/1224 passing after this round (one new test added:
`tests/collection-reminders-race-behavioral.test.ts`). The only failure seen
under full parallel load was the already-documented flaky
`tests/upgrade-subscription-race-behavioral.test.ts`, confirmed passing when
run alone. `tsc --noEmit` clean.

## RESOLVED 2026-10-21: XLSX/invoice/email-report money paths re-confirmed sound; the real bug was in a backup *safety-net script itself*, broken by an earlier refactor it was never updated for

Scope: this pass covered the areas explicitly NOT yet audited — XLSX exports
(`app/api/export/xlsx/route.ts`), invoice/credit-note PDF generation
(`app/api/export/invoice/[orderId]/route.ts`, `lib/money.ts`'s
`createInvoice`/`createCreditNote`/`nextInvoiceNo`/`nextCreditNoteNo`),
backup/restore (`scripts/take-snapshot.ts`, `scripts/restore-backup.ts`,
`scripts/verify-backup.ts`, `scripts/check-backup-coverage.ts`,
`app/api/backup/route.ts`), and the daily email report
(`app/s/reports/_components/ReportsClient.tsx`'s `EmailReportButton` →
`app/api/report/daily/route.ts` → `lib/report.ts`'s `dailyEmailReport`/
`dailyWhatsAppSummary`).

**Confirmed clean, no changes needed:**
- **XLSX export** (`app/api/export/xlsx/route.ts`): every sheet (Summary,
  Transactions, GST Invoices, Credit Notes, Expenses) is built straight from
  `computeReport()`'s own return value — no parallel calculation that could
  drift from the on-screen Reports numbers. College scoping is correctly
  locked down: a campus-scoped staff account's `me.collegeId` always wins
  over `?c=` (the query param is only even consulted when `me.collegeId` is
  falsy, i.e. an owner-level account), and an owner-supplied `?c=` is
  validated against `db.college.findUnique` before use — an unknown/garbage
  id is rejected with 400 rather than silently falling through to the
  combined (`scopeId` undefined) all-colleges view. No way found to edit the
  URL into cross-college leakage.
- **GST invoice numbering & payment-method rule**
  (`lib/money.ts:nextInvoiceNo`/`nextCreditNoteNo`/`createInvoice`): the
  per-FY sequence uses a single `fySequence.upsert` (Postgres
  `INSERT ... ON CONFLICT DO UPDATE SET value = value + 1 RETURNING value`
  under the hood) called *inside* the same transaction (`tx: Tx` parameter)
  that creates the Order/Payment/Invoice rows in `lib/actions/orders.ts` —
  the correct atomic-counter pattern (same shape as the advisory-lock-backed
  bag-code allocator, just via row-level lock instead of an advisory lock,
  which is sufficient here since the whole increment-and-read happens in one
  UPDATE statement with no read-then-write gap for a second transaction to
  land in between). No second, less-safe numbering path found — `nextSeq`
  is the only place either table's `number` column is ever produced.
  `shouldInvoice`/`shouldInvoiceOrder` correctly gate on method (`upi` → tax
  invoice always; `cash` → only with `staffInvoiceOverride`; credit-only →
  never; a `noGst` order → never regardless of method), matching CLAUDE.md's
  "sacred" rule, and `app/api/export/invoice/[orderId]/route.ts` only
  renders an `Invoice` row that already exists — it never invents one for an
  order that wasn't eligible.
- **Daily email report** (`lib/report.ts:dailyEmailReport`,
  `dailyWhatsAppSummary`): both call `computeReport()` directly (day/week/
  month, combined and per-college) with no divergent math — the same
  function the Reports screen and the XLSX export use. `dailyWhatsAppSummary`
  even has its own comment stating this is deliberate ("so the two can
  never disagree"). `app/api/report/daily/route.ts`'s cron-retry guard
  (skip a resend within 15 minutes) is correctly scoped to the cron path
  only (`guardRetries`) — the manual "Email today's report" button always
  sends, as it should for a deliberate click.
- **Restore correctness** (`scripts/restore-backup.ts`): refuses to target
  `public` without `--force-public`, refuses to write into a non-empty
  target schema, loads tables in FK-dependency order (parents first) with
  any model not in the explicit `ORDER` list appended afterward — checked
  that every such "appended" model (`sheetOutbox`, `dayCashCount`,
  `rateLimit`, `waVerify`) has no FK relationship to anything restored
  before it, so load order never actually matters for them. `FySequence`
  rows restore as plain data rows (no separate Postgres `SEQUENCE` object
  backs this counter — it's `lib/money.ts`'s own table), so a restore
  reproduces the exact gap-free counter state with no extra resync step
  needed, and bag codes restore as plain rows too with their partial unique
  index (`UNIQUE(code) WHERE status='active'`) re-enforced by `prisma db
  push` against the fresh target schema before any row loads — a restore
  that produced two "active" rows with the same code would fail loudly at
  `createMany`, not silently succeed.

**Real bug found and fixed: `scripts/check-backup-coverage.ts` — the backup
safety-net script — crashed on every run, because it was never updated when
`app/api/backup/route.ts` was refactored.** The route's own file header
documents a "v2" rewrite: it used to hand-maintain `const TABLES = [...] as
const`, then switched to deriving the table list dynamically from every
Prisma client delegate that has a `findMany`, minus a small `SKIP` set
(`"otp"`) — exactly so a newly-added model is backed up automatically rather
than needing someone to remember to add it to a list (the file's own comment
names the actual incident this prevented: Plan, Bag, DayClose, Attendance
and SlotWindow all silently missing from the old hand list).
`check-backup-coverage.ts` was written to audit the *old* shape: it regexed
route.ts's source text for `const TABLES = [([\s\S]*?)] as const`, which no
longer exists anywhere in that file. `(route.match(...) || [])[1]` is
therefore always `undefined`, and the very next line unconditionally calls
`.matchAll()` on it — a `TypeError: Cannot read properties of undefined
(reading 'matchAll')` on literally every invocation, forever. The exact tool
that exists to make sure "every model is backed up" stays true had been
silently broken since the v2 refactor — running it reported nothing, it just
crashed, which is a worse failure mode than reporting stale-but-wrong
coverage, since a crash at least doesn't masquerade as a clean pass if nobody
is watching stderr. (`scripts/verify-backup.ts`, a sibling script with the
same purpose, had already been correctly updated to the dynamic-derivation
pattern — confirming the route's actual runtime behavior is fine; only the
`check-backup-coverage.ts` checker itself had rotted.)

Fixed by rewriting the checker to match what the route actually does now:
parse the `SKIP` set out of route.ts's source (so a future change to it is
still visible here) and load the real Prisma client to confirm every schema
model either is in `SKIP` or resolves to a delegate with a working
`findMany` — the identical test `backupTables()`'s own filter applies at
runtime, rather than comparing two independently-maintained lists.

New test: `tests/check-backup-coverage-script.test.ts` — runs the script as
a real child process (`npx tsx scripts/check-backup-coverage.ts`, the same
way a human or CI invokes it) and asserts it exits 0 and prints "every model
is covered" rather than throwing. Confirmed it failed (TypeError, exit 1)
against the broken version, passed after the fix. Mutation-tested: reverted
`check-backup-coverage.ts` to the pre-fix content, confirmed the test failed
with the same TypeError output, restored the fix, confirmed green again.

`npm test`: 1223/1224 passing. The one failure is the already-documented
pre-existing flaky test, `tests/upgrade-subscription-race-behavioral.test.ts`
("never overcharges by double-counting the first upgrade's own price") —
re-ran it alone 3 times this pass and it flipped pass/fail/pass, confirming
it's flaky independent of any change made here, not a regression. `npx tsc
--noEmit` clean.

## RESOLVED 2026-10-21: a THIRD hydration-mismatch bug class (missing timeZone) found in the scope the Reports/Sentry hydration pair didn't cover; PWA, slot-capacity and bag-code flows re-audited and confirmed clean

Continuation of the same day's audit series, scoped specifically to areas
NOT yet covered: PWA/service worker, slot-booking capacity, bag-code admin
flows, and a full `app/`+`components/` sweep for the hydration-mismatch bug
class the two entries right below this one (`/s/reports` timeAgo, Sentry
Replay) had just found twice in one day — explicitly flagged as "a third
occurrence is plausible."

**Real bug found: three `new Date(...).toLocaleTimeString/toLocaleString(...)`
calls missing `timeZone`, rendered directly in `"use client"` components.**
`app/s/admin/_components/AdminClient.tsx`'s `hhmm()` helper (staff
attendance "in HH:MM" / "out HH:MM"), the same file's App-Errors panel
timestamp, and `app/s/_components/HomeClient.tsx`'s "On shift since HH:MM"
all called `toLocaleTimeString`/`toLocaleString` with format options but no
`timeZone`. Unlike the timeAgo bug (a RACY mismatch that only shows up if
the clock ticks over a boundary between server and client render), this one
is deterministic and permanent: Next.js SSRs every "use client" component
once on the server to build the initial HTML (in whatever timezone the host
process uses — UTC on Render), then React re-executes that SAME render
function in the browser during hydration, in the visitor's actual local
timezone. Any real staff member whose browser isn't explicitly set to UTC
sees a server-rendered time string that disagrees with the client's
immediately-recomputed one on every single load — not an edge case, every
load, every non-UTC browser — React discards the mismatched subtree, same
`#418` failure as the other two entries. The codebase already had the
correct pattern right next to two of these: `ComplaintsClient.tsx`'s "Reply
by" line already passed `timeZone: "Asia/Kolkata"`; these three just never
got it. Fixed by adding `timeZone: "Asia/Kolkata"` to all three. Also fixed,
same missing option, in a Server Component where it's a real wrong-timezone
display bug rather than a hydration race (Server Components don't
re-execute client-side, so no mismatch, but the ETA shown was still
computed in the wrong zone): `app/c/orders/[id]/page.tsx`'s customer-facing
ETA label (`etaLabel`).

New test: `tests/date-format-hydration.test.ts` — walks every `.tsx` file
under `app/`+`components/` and flags any `Date(...).toLocale(Date|Time)?
String(...)` call whose argument list doesn't contain `timeZone` (a
balanced-paren scan per call, not a per-line regex, so a wrapped call is
still caught; deliberately does NOT flag plain number formatting like
`n.toLocaleString("en-IN")`, which has no timezone to get wrong). Confirmed
it failed naming exactly the three `.tsx` offenders before the fix (not
`page.tsx`'s Server Component one — that file's call was fixed in the same
pass but isn't a hydration bug, so leaving it out of scope for this test's
specific claim is correct), then passed after. Mutation-tested: reverted
the `AdminClient.tsx` `hhmm()` fix alone, confirmed the test failed naming
that exact file, restored it, confirmed green again.

**Re-audited and confirmed clean, no changes needed:**
- **PWA / service worker** (`public/sw.js`): already network-first for
  navigations with a cache fallback, so a stale cached shell can't serve
  old JS against a newer deployed API — every request tries the network
  first and only falls back to cache on an actual fetch failure (offline),
  which is the opposite of the `/app`-stale-shell bug class fixed earlier
  today. Cache versioning (`ff-vNN`) correctly purges all other cache names
  on `activate`. `/api/` is correctly never cached. The `/s` vs `/c` vs `/`
  shell fallback for an offline navigate is scoped correctly per path.
- **Offline banner** (`components/offline.tsx`): listens to both `online`
  and `offline` window events (not just the initial `navigator.onLine`
  read), cleans up both listeners on unmount — correctly tracks
  transitions, not just initial state.
- **Push subscription** (`components/pwa.tsx`, `app/api/push/subscribe/
  route.ts`, `lib/push.ts`): subscribe path validates the endpoint
  (`isPushEndpoint`) and key lengths server-side before upserting, keyed on
  `endpoint` so a resubscribe on the same device correctly updates rather
  than duplicates; `sendPushTo` already auto-deletes a subscription on a
  404/410 send failure (dead endpoint) and logs every OTHER failure kind to
  `ErrorLog` (a fix already made for this exact file, re-verified intact).
  **One gap flagged, not fixed**: there is no unsubscribe call anywhere —
  `logout()`/`signOutEverywhere()` (`lib/actions/auth.ts`) clear the session
  but never delete or unsubscribe that device's `PushSubscription` row, so a
  shared device (e.g. a counter tablet) keeps receiving the previous staff
  member's push notifications until a different user's login happens to
  resubscribe over the same browser endpoint (the upsert is keyed on
  `endpoint`, so it does eventually self-correct on the next login on that
  device — not a data leak to a different person's account, just a staff
  member who signed out still getting notified on a device they walked away
  from). Fixing this properly needs a new unsubscribe route plus a client
  call wired into both logout flows (`app/s/_components/SignOut.tsx`,
  `app/c/profile/_components/ProfileClient.tsx`) — a real feature addition,
  not a one-line fix, so left for a dedicated follow-up rather than built
  into this audit pass.
- **Slot-booking capacity** (`lib/slot-capacity.ts`): already uses a
  Postgres advisory lock keyed on `(collegeId, startAtISO)` inside the same
  transaction that creates the order, with the capacity count read AFTER
  the lock — the exact race this function's own file-header comment
  documents fixing on 2026-09-05, and `tests/slot-capacity-race-behavioral.
  test.ts` already proves two concurrent last-slot bookings can't both
  succeed. Only one call site (`lib/actions/orders.ts`'s `placeOrder`), no
  bypass path found. Per-college/per-day scoping (`buildSlots`/`SlotWindow`)
  confirmed correct — a window's `collegeId` is part of both the lock key
  and the capacity query.
- **Bag-code admin flows** (`lib/actions/bags.ts`): `setBagCode`'s ("Change
  ID") pre-check for an already-in-use code (`status: { not: "released" }`)
  is strictly BROADER than the actual DB guarantee (the partial unique index
  is `UNIQUE(code) WHERE status = 'active'`, per `scripts/ensure-guards.
  mjs`), so it can only over-reject, never under-reject — a race between two
  concurrent renames onto the same code still correctly throws `P2002` and
  gets a friendly message. `issueBag`/`reissueBagSameCode` both lock
  (advisory lock / row re-check inside the transaction) before allocating or
  reusing a code, already covered by existing behavioral tests.
  `retireBag`/`reissueBagSameCode` racing an "active order on that bag" is
  not a real risk because `Order` has no foreign key or any reference to
  `Bag` at all (orders are tied to `studentId`, never to a specific bag
  row) — there is nothing for a bag-status change to race against.

`npm test`: 1219/1219 passing (one new test file,
`date-format-hydration.test.ts`). `npx tsc --noEmit` clean. `npm run build`
not re-run this pass (no route/type changes, only literal object-key
additions and one new test file).

## RESOLVED 2026-10-20: structural audit — no ESLint ever configured, a real missing-UI bug (unread badge), and 44 dead-code findings triaged

Owner: "its been since then app is never perfect i see silly mistakes and bugs
all the time ... go and check full build whether it is perfect in the
structure or not." This was a request to audit the BUILD'S STRUCTURE, not
business logic — dead code, unused imports, half-wired features, config gaps.

**Root-cause finding: this project has never had ESLint configured.** No
config file anywhere, no `eslint` package in `package.json` (dependencies or
devDependencies). For a 3-month solo build this is the most likely structural
explanation for recurring "silly bugs" — dead imports, unused variables, and
half-wired props compile silently with no `tsc` or lint signal, so they
accumulate invisibly until someone goes looking. Not fixed this round (adding
a real ESLint config is a separate decision — rule selection, and it will
surface its own wave of findings — flagged to the owner rather than done
silently).

**Stopgap used instead: `noUnusedLocals`/`noUnusedParameters` in
tsconfig.json.** Temporarily enabling these (now permanent) surfaced exactly
45 unused-local/import findings across the app — a bounded list. Each one was
individually checked against call sites and comments for "is this a real
missing feature, or genuinely dead" before touching it — NOT a blind delete
pass, specifically because that same blind-delete instinct is how a past
session nearly deleted a parked feature (see the `baseGarmentRate` entry
below).

**Real bug fixed: the customer tab bar's unread-notification badge never
rendered.** `app/c/_components/TabBar.tsx` destructured `unread` from its
props but never used it in the JSX — `app/c/layout.tsx` was correctly
querying and passing a live unread count every render, straight into the
void. Fixed by wiring it into the Home tab's `badge` prop, same pattern
`components/chrome.tsx` already uses for the staff Complaints-count badge.
Students have presumably never seen this badge since it was built.

**Two items flagged for the owner, NOT built or deleted without a decision:**
- `app/s/orders/[id]/{page.tsx,_components/OrderClient.tsx}` carried a dead
  `baseGarmentRate` prop. The caller's own comment revealed the original
  intent: let staff preview the excess-weight charge before committing,
  using the same `excessWeightCharge` function that bills it server-side.
  That preview was never actually wired up in `OrderClient.tsx` — removed the
  dead prop plumbing as out-of-scope new-feature work, server-side billing is
  unaffected and correct either way.
- `app/s/customers/[id]/_components/CustomerClient.tsx` had a fully built,
  previously-tested `doRetireBag` handler calling `lib/actions/bags.ts`'s
  `retireBag` — confirmed zero other call sites anywhere in the app. Distinct
  from the already-wired "Lost — reissue" flow (`reissueBagSameCode`, which
  retires AND reissues in one action) — `retireBag` only retires, no reissue,
  per its own doc comment. Judged genuinely redundant with "Lost — reissue"
  and "Student left," so removed (not built into new UI) — flagged as a
  judgment call, not an obvious missing piece like the badge above.

**Near-misses that were deliberate, not bugs (confirmed via existing
comments before touching):** `components/pwa.tsx`'s unused `deferred` state
(the real install-prompt trigger is a separate module-level singleton in
`lib/pwa-install.ts`); `lib/actions/students.ts` and `lib/actions/wa-register.ts`'s
unused `sendWhatsApp` imports (both have explicit comments: broadcasts are
in-app/web-push only, no WhatsApp welcome message by design).

**One self-inflicted regression during this pass, caught by the test suite
before commit:** removed two `collegeExpressFee()` calls in
`lib/actions/orders.ts` (inside `acceptOrder`/`walkInOrder`) because the
`urgentCharge` variable they assigned to was never read — the real charge is
`surcharge`, computed fresh a few lines later from the same inputs. But
`tests/mobile-fixes.test.ts` explicitly guards "every flat-fee call site still
exists — now gated to cycle colleges only," expecting exactly 5
`collegeExpressFee(...)` call sites as a deliberate parallel-computation
sanity check so the two paths can't silently drift apart. Restored both
calls as `void collegeExpressFee(...)` with a comment explaining why they
exist unused. Lesson: a test asserting a *count* of call sites, not just
their presence, is itself documentation of an intentional redundancy —
treat that differently from an ordinary "this looks unused" finding.

**Verification:** `npx tsc --noEmit` and `-p tsconfig.verify.json` both clean.
`npm run build` succeeded, same route table as before any edits. `npm test`:
1204/1204 passing (after the collegeExpressFee restore above — initially 2
failed for exactly that reason). `npm run verify`: every step passed except
the already-known, owner-told-to-ignore wash-day gap in `database integrity`
(unrelated to this round's changes — same 5 students it's always been).

Net: 1 real bug fixed (unread badge), ~33 files of confirmed-dead-code
cleanup, 1 structural root-cause identified (no ESLint, not fixed — needs a
scoped follow-up), 2 items flagged for the owner's product call.

## RESOLVED 2026-10-20: deep audit round 2 — UI clip fix, an overcharge bug, a session-revocation bypass across 7 routes, and an erasure race

Owner, continuing the same "I'm not confident, test more" session: asked for
deep core testing AND a responsive-UI pass. Clarified first whether "use
Bootstrap" meant literally adding Bootstrap (a real architectural change,
conflicting with this app's own design-system-v2 rules) — owner wanted the
narrower "something looks broken, just fix it" instead. Three more parallel
audits launched (auth/permissions/privacy; complaints/subscription/ops/slots;
plus a manual UI sweep across mobile/desktop viewports with a staff and a
customer session minted directly via a signed JWT, since WhatsApp login isn't
configured locally — `AUTH_SECRET` must be loaded from `.env`, not the
`"dev-secret"` fallback, or the minted cookie silently fails `jwtVerify` and
redirects to `/login` with no error shown).

**UI: "Free re-service" button clipped at mobile width.** `app/s/complaints/
_components/ComplaintsClient.tsx`'s three action buttons (Resolve/
Compensate/Free re-service) were in a plain `.row` with no `flex-wrap` —
overflowed past 375px, truncating to "Free re-ser". Fixed with the `wrap`
class already used for this exact pattern in `CustomerClient.tsx`/
`OrderClient.tsx`/`reports/page.tsx`/`profile/page.tsx` — this screen just
missed it. Rest of the app (login, staff home, students, reports with
charts, order detail, admin, customer home, order creation's 4 service tabs
including the per-item picker, registration form) checked out clean across
375px/1440px. Note for future sessions: several of these pages have a
fade-in transition on mount that looks "completely blank, data never
rendered" in a screenshot taken immediately after navigation — always wait
1-2s before concluding a page is broken; three separate false alarms this
session were just that.

**`upgradeSubscription` overcharge (lib/actions/subscription.ts).** The
cycles/buckets math was already correctly rebuilt from a fresh, row-locked
read inside the transaction (an earlier fix) — but the PAYMENT amount
(`difference`) was computed ONCE, before the transaction, from the
pre-transaction `cur`/`oldGross` snapshot, and used unchanged. Two
concurrent upgrades for the same student targeting DIFFERENT destination
plans (two counters/Managers — NOT a same-plan double-tap, which the
existing `fresh.planId === plan.id` re-check already caught) both read the
same starting plan before either committed: the second call's fresh read
correctly saw the first upgrade's new plan for the CYCLES math, but the
stale `difference` closure still charged (secondPlan − originalPlan)
instead of (secondPlan − firstUpgradePlan) — overcharging by exactly the
first upgrade's own price, already paid once. Fixed by recomputing
`oldGross`/`difference` from the same fresh, locked `planRef` read already
used for the cycles rebuild. New test:
`tests/upgrade-subscription-race-behavioral.test.ts` — two concurrent
upgrades A→B and A→C must total exactly (C's price − A's price), not
(B's price − A's price) + (C's price − A's price).

**Session-revocation bypass, 7 routes (lib/cron-auth.ts).** `purge-photos`,
`error-digest`, `collection-reminders`, `stuck-orders`, `cron-watchdog`,
`sheets/sync`, `sheets/flush` each independently defined their own
`authorised(req)`: `getSession()` → `db.staff.findUnique` → bare
`role >= N`. None of them checked `st.active` or `s.epoch ===
st.sessionEpoch` — the exact two checks `requireStaff()` exists specifically
to re-verify on every call, because deactivating a staff member or using
"sign out everywhere" is supposed to take effect immediately, not at the
365-day session token's natural expiry (see `setStaffActive`'s own comment).
A removed Admin/Owner's still-validly-SIGNED cookie could keep triggering
any of these seven routes indefinitely — the identical bug class already
fixed once for `/api/rt` ("the SSE stream never re-checked session
revocation"), just never applied to this second family of routes. Fixed by
adding `isCronOrStaff(req, minRole)` to `lib/cron-auth.ts`, which routes
through `requireStaff()` instead of duplicating the weaker check — same
centralizing idea this file already used once for the CRON_SECRET
timing-safe comparison. Also fixed the same gap, narrower blast radius, in
`app/api/export/invoice/[orderId]/route.ts`'s customer branch (compared the
raw JWT's `studentId` against the invoice, never called `requireStudent()`)
— a lost phone's stale session could keep loading/printing that student's
own GST invoice forever, defeating "sign out everywhere" for this one
endpoint. New test: `tests/cron-or-staff-behavioral.test.ts` — proves a
deactivated staff account and a sessionEpoch-revoked session are both
refused, where the old hand-rolled check would have accepted either.

**Erasure race + PII-in-audit-log (lib/actions/privacy.ts).**
`eraseMyData`/`eraseStudentData` checked `anonymisedAt` and "any active
order" OUTSIDE the transaction, no lock, no re-check inside — same
precondition-then-write shape as every other race this session found
elsewhere. Narrowest real consequence: an order that wasn't yet "received"/
"processing" at check-time but commits into that state microseconds later
(acceptOrder/walkInOrder racing the check) would let erasure proceed anyway,
anonymising the phone to `deleted-{id}` while a real order is now in
flight — breaking SMS/pickup-OTP for exactly the order the check exists to
protect. Fixed with the same lock-then-fresh-recheck pattern used
throughout this session (locks the Student row, re-reads `anonymisedAt` and
the active-order query fresh inside the transaction). Separately, also
fixed: `eraseStudentData`'s OWN audit-log line baked the student's real
name into the very event recording their erasure (`${stu.name} (${stu.id})
anonymised — ${note}`) — AuditLog rows are never touched by erasure, so the
real name was permanently preserved right next to the event meant to remove
it, contradicting the feature's own stated purpose (this file's header
comment: "every field that identifies a person is overwritten"). Fixed by
dropping the name from that one line, matching `eraseMyData`'s own log line
which never had this problem. New test:
`tests/erasure-race-behavioral.test.ts` — two concurrent erasures of the
same student: exactly one succeeds, `sessionEpoch` increments once, not
twice (the double-increment is what the old unlocked code produced).
**Not fixed, flagged for a future session**: `AuditLog.detail` bakes a
student's real name (sometimes phone) into ~20 other call sites across
`lib/actions/*.ts` unrelated to erasure itself (plan purchases, phone
changes, bag issuance, etc.) — these rows are never scrubbed by erasure
either, a genuine but much larger gap (needs a structured `studentId`
column on `AuditLog` plus a redaction pass, not a one-line fix) that this
round only patched at the two erasure-specific call sites.

**Also checked and confirmed clean this round** (per the two delegated
audits, condensed): complaints lifecycle (cross-student complaint, double
free-reservice, double-resolve — all already correctly guarded, verified
unmodified); `activateSubscription`/`adjustCycleUsage`/`cancelSubscription`/
`sellCyclePack`/`assignSubscription` (all fresh-locked-read, no regressions);
ops/payroll (`clockIn`/`clockOut`/`closeDay`/`topUpCredits`/`createPayslip`,
all documented fixes present, net-pay guard confirmed server-side not just
client-side); slot-booking capacity (overbooking, past-slot, too-far-ahead
all correctly blocked); loyalty tier (purely cosmetic, not read by any
pricing/eligibility logic, not gameable); every credit-granting function
(no student-callable self-grant anywhere) — one DB-backstopped,
lower-priority gap left open: three credit-DECREMENT call sites
(`sellCyclePack`, `activatePlan`, `payInner`) check the balance before a
lock, but the `ff_credits_not_negative` CHECK constraint already prevents
an actual overdraw at the DB layer — only the error MESSAGE on the losing
concurrent request is poor (an unhandled constraint-violation error instead
of a friendly "not enough credit"), not a financial-safety issue. Left for
a future pass. `lib/auth.ts` core session/role/lockout logic, `wa-login.ts`/
`wa-register.ts`, OTP/passcode timing-safe comparisons, and the full
campus-isolation (`assertSameCollege`) sweep across all 16 `lib/actions/
*.ts` files: all re-verified clean, no regressions, no new gaps.

**Verified**: full suite 1204/1204 (one flaky full-suite-only failure on a
first run, reproduced as passing in isolation and on a clean full-suite
rerun — a transient DB-connection-pool timing issue under ~118 concurrent
test files' real Postgres transactions, not a code bug), `tsc --noEmit`
clean. Every fix in this entry has a real behavioral test that was
individually proven — reverted the fix, confirmed the test fails for the
right reason, restored the fix, confirmed it passes — to actually catch the
regression it guards, continuing the discipline established in the
concurrency-audit entry above this one.

## RESOLVED 2026-10-20: deep concurrency audit — 6 real races/bugs found and fixed, all with behavioral tests proven to catch the regression

Owner, after a long session of real bugs found live, asked for a deep core
audit ("I am not confident... take your time"). Ran three parallel deep
audits (registration/bag-code residuals, money correctness, concurrency
across every `db.$transaction` call site) rather than a surface pass. Full
money-correctness sweep (GST, refunds, credit notes, FySequence numbering,
express surcharge, Decimal precision) came back clean except two
documentation-only staleness issues (money.ts's file-header comment says
GST is extracted from an inclusive price; the actual, correct, in-use
formula adds it on top — the code is right, that one comment is wrong).
Six real bugs found and fixed below. Every one of them is now locked down
by a behavioral test that was PROVEN to catch the exact regression (reverted
the fix, confirmed the test fails, restored the fix, confirmed it passes
again) — not just written and assumed correct.

**1. `acceptOrder` had no atomic status guard — the most serious finding.**
Every sibling status transition in `lib/actions/orders.ts` (collectOrder,
advanceStatus, cancelOrder) was already fixed for this exact class of bug;
acceptOrder was missed. It read `o.status`, checked `!== "draft"`, then did
a plain unconditional `tx.order.update` — no lock, no `updateMany` scoped to
the starting status. Two near-simultaneous accepts of the same draft order
(a double-tap, a client retry, two counters opening the same pre-booked
order — explicitly "a real, plausible scenario" per this file's own
existing comments on a related race) could both pass the check and both
burn a subscription cycle for ONE physical wash — real prepaid value,
silently double-debited. Fixed by locking the Order row (`SELECT ... FOR
UPDATE`) before the status check, same pattern already used for the
Subscription row a few lines below in the same function. New test:
`tests/accept-order-race-behavioral.test.ts`.

**2. `refundOrder`'s cycle-restore used the STALE pre-transaction order
snapshot.** The refund AMOUNT cap was already correctly protected (locked,
fresh-read) — but `restoreCycleFor`'s precondition check (`if
(!ord.usedCycle...)`) was handed the OUTER `o`, fetched before the
transaction even started, not the freshly-locked `fresh` read done for the
amount cap. Two concurrent refunds with `restoreCycle=true` on the same
order — even well under the rupee cap, so the amount check alone wouldn't
catch it — could both see `usedCycle=true` and both decrement the
subscription, double-crediting a cycle that was only burned once. Fixed by
widening the fresh read's `select` (added `id`, `usedCycle`, `service`,
`cyclesCount`) and passing `fresh` to `restoreCycleFor` instead of `o`.
**The first version of this test was accidentally vacuous** — a scenario
where cyclesUsed went 1→0 either way, since the decrement's own
negative-floor clamp masked the bug by coincidence. Caught by mutation-
testing the test itself (ran it with the bug still present — it passed when
it should have failed), redesigned with `cyclesUsed` starting at 2 (as if
another order's cycle was also burned) so a double-restore produces a wrong
0 instead of the correct 1. New/extended test:
`tests/refund-race-behavioral.test.ts`.

**3. `activatePlan`'s new `firstBag` bag hardcoded `issuedBy: "system"`,
losing the real staff member.** Every sibling bag-creation path (issueBag,
the BVRIT/faculty branch in registerStudent three lines away) correctly
attributes to the real authenticated staff id; this one path — now the MOST
COMMON registration path, every plan-based St Mary's signup — silently
wrote the literal string used elsewhere only for genuinely automated bags.
No UI currently displays `Bag.issuedBy`, so no visible symptom yet, but it
was a real, silently-wrong value from the moment it would have deployed —
corrupting the first "which staff member issued this" query anyone ever
runs. Fixed by threading the real `st.id` through `firstBag.issuedBy`.
New test (in `tests/register-student-walkin-id-behavioral.test.ts`):
asserts the minted bag's `issuedBy` matches the session's real staff id,
not the literal "system".

**4. `registerStudent`'s BVRIT/faculty bag-collision mislabeled as "phone
already registered".** `allocateBagCode`'s recycled-code search (two
`findMany` calls, no lock — a known, documented hazard `issueBag` already
defends against with a 3-attempt retry loop) can let two concurrent BVRIT/
faculty registrations pick the same candidate code; the loser's
`tx.bag.create` throws P2002. The catch here assumed the ONLY possible
P2002 in this transaction was the pre-checked `phone` unique constraint and
told that staff member a flatly false thing — "This number is already
registered" — when the real, one-time, retryable cause was a bag-code
collision. Fixed with the same retry pattern `issueBag` already uses (up to
3 attempts on P2002), and the final-failure message is now disambiguated by
an actual re-check (`db.student.findUnique({where:{phone}})`) instead of
assumed.

**5. `customerIdFor`'s self-heal could mint TWO simultaneously active bags
for one student, and could crash an unrelated enclosing transaction.** Two
distinct bugs in one function (`lib/bagcode.ts`): (a) no lock, no in-
transaction re-check — two concurrent calls for the same never-bagged
student (realistic: two Sheet-event call sites racing for the same new
student) both pass the "no bag yet" check, both allocate a DIFFERENT code,
both succeed — nothing catches it, since the DB's uniqueness guarantee only
protects one CODE from reuse, not "one active bag per student". (b) `db`
here is sometimes actually a `Prisma.TransactionClient` (every caller
inside `lib/sheet-events.ts`'s wrapper passes `tx`, not the top-level
client) — and a TransactionClient has no `$transaction` method (Prisma
doesn't support nesting), so a self-heal triggered from inside an
already-open transaction (e.g. a zero-bag student reached via acceptOrder/
collectOrder/payInner/sellCyclePack's own `customerIdFor(tx,...)` call)
used to throw `"tx.$transaction is not a function"`, aborting the WHOLE
enclosing transaction with a confusing internal error. Fixed both at once:
reuses `issueBag`'s exact advisory-lock key (`bag-issue|${studentId}`) so
the two code paths now serialize against EACH OTHER too, with a fresh
in-lock re-check; and detects whether the given client already has
`$transaction` (top-level) or not (already inside one) before deciding
whether to open a new transaction or just use the lock directly against
what's given.

**6. `placeOrder`'s "one open draft" rule had no transactional re-check.**
Checked via a plain `db.order.findFirst` outside the transaction, never
re-checked inside it, no DB constraint backing it. Two concurrent
`placeOrder` calls from the same student (double-tap, retried request)
could both pass and both create a draft, defeating the rule the owner
explicitly asked for ("bulk drafts... hectic"). Lower severity than the
others (duplicate drafts, not duplicate money/cycles) but the identical
check-outside/no-recheck-inside shape. Fixed with the same advisory-lock-
then-fresh-recheck pattern as everywhere else in this file.

**Also fixed, found by the SAME audit pass**: `allocateBagCode`'s
FySequence row creation (`lib/bagcode.ts`) was a plain
findUnique-then-create — a classic find-then-act race for a letter's FIRST-
EVER mint. Narrow under the OLD single-shared-row scheme (could only ever
race once, in the app's whole lifetime) but today's per-letter rewrite made
all FIVE letters freshly cold at once, right at this deploy. Replaced with
a single atomic `INSERT ... ON CONFLICT DO UPDATE SET value =
GREATEST(current, floor) + 1` — Postgres serializes this at the row level
regardless of concurrent callers, no separate read-then-write steps left to
race. New test: `tests/bagcode-cold-start-race-behavioral.test.ts` (5
concurrent first-ever BVRIT mints, all succeed, all distinct, sequence ends
at exactly 1005 — proven to crash with the old pattern via mutation
testing). `tests/bagcode-recycle.test.ts`'s fast mock-based suite was
updated to simulate the new atomic-upsert semantics (verified the exact
argument positions against a real tagged-template call rather than
guessing) instead of the old 3-method FySequence mock.

**repair-missing-bags.ts** (the one-off script from this session's earlier
fix) had the identical "read precondition once, write without rechecking"
shape — if run twice, or while a student on its worklist gets a bag issued
by staff mid-run, it could double-mint. Low real-world severity (manual,
dry-run-by-default, one-off admin tool) but fixed with the same lock +
fresh re-check for consistency.

**Deliberately NOT fixed, flagged for a future session**: two schema/
comment staleness issues (`prisma/schema.prisma`'s comment on `Bag.code`'s
partial index says `WHERE status <> 'released'`; the actual SQL installed
by `ensure-guards.mjs` is `WHERE status = 'active'` — these differ for
lost/replaced bags, not a bug, just a misleading comment); `acceptOrder`/
`walkInOrder`'s `urgentCharge` local variable is computed but never read
(dead code, not a double-charge — the real charge comes from the separately
computed `surcharge` a few lines later) — a cleanup, not a fix.

**Verified**: full suite 1196/1196, `tsc --noEmit` clean, `npm run verify`
(typecheck + tests + build + backup coverage + ledger guards + full QA
pipeline + launch readiness) all green except the already-known,
deliberately-unaddressed wash-day gap. Every one of the 6 fixes above has a
real behavioral test against a real Postgres database (not a source-regex
check), and every one of those tests was individually proven — by
temporarily reverting its fix, confirming the test fails for the right
reason, then restoring the fix — to actually catch the regression it claims
to guard, not just to exist.

## RESOLVED 2026-10-20: cron-sheets-sync's recurring Google Sheets 429 — the hourly sync was re-confirming tabs that already existed, every single run

Follow-up to the cron-bill entry below, which found but deliberately didn't
fix this. Owner asked for it directly afterward.

**Root cause**: `writeSheet` (lib/sheets.ts), called once per tab by the
hourly aggregate sync (`lib/sheets-sync.ts`), made an unconditional
`batchUpdate` call to CREATE the tab on every single invocation — "ignore
the error if it already exists" was the whole strategy. With ~20 tabs
written per sync (combined + per-college Live/Daily/Revenue/Complaints/Staff,
plus Plans/Students/Config) at 3 calls each (create + write + trim), that's
up to 60 requests per run — and after the very first sync ever, EVERY tab
already exists, so roughly a third of the sync's own request volume, every
single hour, forever, was spent re-confirming something already true.
Google allows ~60 write requests/minute/user, so this sync was running
right at the ceiling by design, not by accident — confirmed directly:
`curl`ing `/api/sheets/sync` with the real `CRON_SECRET` returned HTTP 503,
`{"ok":false,"error":"Live tab write failed: write failed (429): ...
Quota exceeded for quota metric 'Write requests'..."}`, failing on the
very FIRST tab the sync writes.

**Fixed** by making tab creation reactive instead of unconditional: `writeSheet`
now tries the data write (PUT) optimistically first. Only if that fails with
Google's SPECIFIC wording for a missing sheet ("Unable to parse range: ...")
does it call `batchUpdate` to create the tab, then retry the write once. A
400 for any OTHER reason (bad data, an invalid range) still fails immediately
with no retry, exactly as before — checked deliberately, because the existing
test suite already had `"does not retry a real error (a 400 fails
immediately)"` pinned down, and a naive "retry on any 400" would have quietly
broken that invariant (caught locally before this ever reached the real
app — see Verified below). Common case (tab already exists, true after the
first-ever sync) is now 2 requests instead of 3 — cuts the sync's total
request volume by roughly a third. Also capped the previously-uncapped
computed backoff branch in `gfetch` at 10s (the `Retry-After` branch already
had this cap; the fallback didn't), so a future retry-count increase can't
accidentally produce an unbounded wait.

**Scope, deliberately bounded**: `appendSheet` (the PER-EVENT log — every
order/payment/complaint/collection) has the exact same unconditional-create
pattern and runs far more often than the hourly sync, so it's plausibly an
even bigger total contributor to Google's quota — but it wasn't the thing
reported as failing, and its "never throws" contract plus the
already-present empty-tab-detection GET make the safe refactor more
delicate. Left alone this round; if `appendSheet`-driven writes (Orders/
Payments/Complaint log/Collections tabs) are ever reported failing the same
way, apply the identical optimistic-write-then-create-on-miss pattern there.

**Verified**: new tests in `tests/sheets-write-order.test.ts` lock down all
three cases — tab-already-exists makes zero `batchUpdate` calls, a
genuinely-missing tab (Google's exact error text) creates it and retries
once successfully, and a 400 for an unrelated reason is never mistaken for
a missing tab. Full suite 1191/1191 (3 new tests), `tsc --noEmit` clean.
Confirmed the regression risk was real, not theoretical: the first version
of this fix retried on ANY 400, which silently broke the pre-existing
`"does not retry a real error"` test — caught by running the full suite
before considering this done, not assumed safe from the diff alone.

## RESOLVED 2026-10-20: cut the Render cron bill — removed a confirmed no-op cron, widened the uptime check; found (not yet fixed) a recurring Sheets-sync 429

Owner asked to reduce the monthly Render bill, specifically flagging crons
("i dont need all corns"). Checked every cron job's actual Render billing
impact (via the Render API, not guessing) rather than just reading
render.yaml's comments.

**Removed `cron-watchdog` entirely.** It ran every 5 minutes — 288 billed
runs/day, by far the highest frequency of anything in render.yaml — hitting
`/api/cron/watchdog`, whose own code comment already says it's been a
confirmed no-op since 2026-10-11 (the owner disabled its only effect, an
instant per-5-minute error email, "too many notifications," and the route
was deliberately left as a harmless GET specifically so the cron schedule
wouldn't need touching — see that commit's message). With cost now the
thing being optimized for, that reasoning no longer applies: removed the
`render.yaml` entry outright. Real server errors still surface in Admin ->
App Errors and the once-daily `cron-error-digest` email; nothing was lost.

**Widened `cron-uptime-watchdog` from every 5 minutes to every 15.** This is
the ONE alert that still fires when fabricfold.in is fully unreachable (it
emails Resend directly, doesn't depend on the app being up at all) — genuine
value, kept. But it was also the single most frequent REAL (non-no-op) cron
job, so the highest-leverage remaining place to trade a little detection
latency for cost: worst-case full-outage detection goes from 5 minutes to 15,
still fast for a staffed counter, cuts this job's run count ~66%.

**Found, NOT fixed (flagged for the owner, separate from cost-cutting)**:
`cron-sheets-sync`'s hourly run has been failing intermittently —
`curl -sf` exits 22 (an HTTP error status). Reproduced directly by hitting
`/api/sheets/sync` with the real `CRON_SECRET`: **HTTP 503**, body
`{"ok":false,"error":"Live tab write failed: write failed (429): ... Quota
exceeded for quota metric 'Write requests' and limit 'Write requests per
minute per user' of service 'sheets.googleapis.com' ..."}`. This is Google's
own per-minute write-quota limit, not a FabricFold bug in the narrow sense,
but `lib/sheets-sync.ts`'s aggregate rebuild (Live/Daily/Plans/Students
tabs) is issuing enough writes in a short window to hit it — plausibly
compounded by the SAME overlapping-drainers pattern the "RESOLVED 2026-09-11
(pass 17)" entry above already documented for `flushSheetOutbox` (the
fire-and-forget per-event flush and this hourly full-rebuild can land close
together). A FAILED cron run still burns billed runtime for nothing, so this
is relevant to the cost-cutting goal even though it isn't itself a cron
frequency change — fixing it properly needs either batching the aggregate
tabs' writes into fewer API calls, adding a retry-with-backoff specifically
for 429s, or spacing this sync further from the outbox flush drainer. Left
for a dedicated pass with the owner's scope sign-off rather than guessed at
here, same reasoning the pass-17 entry already gave for not rush-fixing
SSE wiring.

**Verified**: full suite 1188/1188 after the render.yaml edits (no app code
touched, only the cron schedule file) — `tests/sheet-sync-copy-matches-schedule.test.ts`
(checks `cron-sheets-sync`'s own schedule against Admin copy) still passes
since that job's schedule was untouched. Deployed; confirmed via the Render
API that `fabricfold-scd2` now lists 9 cron jobs instead of 10, and
`cron-uptime-watchdog`'s schedule reads `*/15 * * * *`.

## RESOLVED 2026-10-20: a St Mary's registration could end up with a PAID subscription and ZERO bags — bag issuance made atomic with the subscription

Owner spotted it from a screenshot of the staff Students list: two
recently-added St Mary's students ("Samriddhi pandey", "K raghavendra")
showed their raw 6-digit internal id as their "Customer ID" instead of a
proper lettered code (e.g. G1547), sitting right next to other recent
students with correct codes. Both were under the "Subscribers" filter — they
had paid, active Subscriptions, just no Bag row at all.

**Root cause**: `registerStudent` (lib/actions/admin.ts) used to do this in
two separate, non-atomic steps for any St Mary's non-faculty registration
("needsPlan"): (1) create the Student with explicitly NO bag ("bag comes
from the plan below"), then (2) call `activatePlan` (lib/plan-activation.ts)
in its OWN transaction to create the Subscription + Payment, then (3) call
`syncBagToPlan` → `issueBag` AFTER that had already committed, to mint the
bag. Step 3 wraps everything in a try/catch that deliberately swallows every
error — the code's own comment framed this as correct: "a subscription that
has been paid for must not roll back because a code could not be allocated".
If step 3 failed for ANY reason (most plausibly a code-collision retry
exhausted, or a transient error, especially plausible during a BULK
admission-week registration burst), the Subscription stayed committed
forever, with nothing more than an audit-log string and a toast — no
enforcement that anyone would ever see or act on it.

**The fix reverses that risk tradeoff for this specific, common case.**
`activatePlan` now accepts an optional `firstBag: { code, tier }` param
(lib/plan-activation.ts). When given — which `registerStudent` now always
does for a non-BVRIT `needsPlan` registration — the Bag is created INSIDE
the SAME transaction as the Subscription and Payment, placed deliberately
BEFORE the payment-event enqueue calls (see the next paragraph for why
ordering matters). If the bag create fails (realistically: the staff-typed
code was taken by someone else in the race between admin.ts's pre-check and
this call — caught as P2002), the WHOLE transaction rolls back: no
Subscription, no Payment, no Bag, nothing to repair, and the caller gets a
clean "pick another code and try again" instead of a half-done student. A
"subscription with literally no bag" is a worse, silently-broken state than
"the sale didn't go through and can simply be retried" — the old reasoning
had this backwards for a brand-new registration specifically (a case with no
swap/retire-old-bag complexity, unlike an EXISTING student changing plans
later via `assignSubscription`, which still uses the old
activatePlan-then-syncBagToPlan-after pattern unchanged — deliberately out
of scope here, see "Not done" below).

**A real duplicate-bag regression was caught and fixed WHILE building this
fix**, worth recording since it's a subtle lesson on its own:
`enqueuePaymentEvent` (lib/sheet-events.ts) resolves a Sheet row's Customer
ID via `customerIdFor` (lib/bagcode.ts), which SELF-HEALS by minting its own
bag the instant it sees an active subscription with zero existing bags —
exactly the safety net this whole bug report was about. Creating the new
`firstBag` AFTER the payment-event calls (the first attempt) meant that
self-heal path won the race: it saw the subscription (just upserted) with
no bag yet, and minted an unwanted extra auto-numbered bag, THEN the
explicit `firstBag` create added a second bag with the typed code — caught
immediately by `tests/register-student-walkin-id-behavioral.test.ts`
asserting `bags).toHaveLength(1)`. Fixed by moving the `firstBag` create to
run FIRST, right after the subscription upsert and before any payment event
— reads see their own transaction's writes, so `customerIdFor`'s self-heal
check finds the real bag already there and has nothing left to heal.
**Lesson**: any transaction that creates a Subscription and calls
`enqueuePaymentEvent`/`customerIdFor` is implicitly racing bag creation
against the self-heal fallback — bag creation must happen BEFORE those
calls, not just "inside the same transaction," or the self-heal path quietly
wins and produces a duplicate instead of a missing bag.

**Repair for the two (and any other) already-broken production students**:
`scripts/repair-missing-bags.ts` (new) finds every active Subscription with
zero Bag rows, mints the correct tier-lettered code via the same
`allocateBagCode` the rest of the app uses, creates the Bag, audits it, and
notifies the student — dry-run by default, `--apply` to write. Verified
against a locally-seeded broken student: dry run reported it correctly,
`--apply` minted a real tier-matched code, a second dry run then reported
zero affected students, and `scripts/db-integrity.ts`'s new check (below)
went green.

**Belt-and-braces**: `scripts/db-integrity.ts` gained a permanent check —
"every active subscriber has at least one bag" — specifically because this
whole bug class is invisible to referential-integrity checks (no FK is
violated; a Subscription with no Bag is a perfectly valid row shape) and was
only found because the owner happened to eyeball a screenshot. This should
read zero forever now; a nonzero reading means the atomicity guarantee broke
again, here or in some new code path, and should be investigated before
reaching for the repair script again.

**Not done**: `assignSubscription` (an EXISTING student picking/changing a
plan later, lib/actions/subscription.ts) still uses the old
`activatePlan`-then-`syncBagToPlan`-afterward pattern, unchanged — it was
investigated and confirmed to share the same structural gap, but fixing it
properly needs the more complex retire-old-bag/upgrade-swap logic
`syncBagToPlan` already handles, which doesn't fit this transaction's simple
"mint one complimentary first bag" shape without a larger refactor. Flagging
per this file's own rule (fixing something that rhymes with an entry here
should say so out loud) — a future session fixing a "subscription with no
bag" report for an EXISTING student (not a fresh registration) should know
this is the same root cause, deliberately left unfixed in `assignSubscription`
this round, not a new bug.

**Verified**: full suite 1188/1188, `tsc --noEmit` clean. Directly proved
the atomicity guarantee with a throwaway script: two `activatePlan` calls
with the SAME typed bag code — the first succeeds, the second fails cleanly
with zero Subscription/Payment/Bag rows left behind for that student (no
partial state to clean up). Directly proved the repair script against a
seeded broken record.

## RESOLVED 2026-10-19: bag-code numbers are now unique PER LETTER, not across every letter — reverses a prior deliberate design

Reported live by the owner: registering a St Mary's student with customer ID
"S1546" was refused — "The number 1546 is already used by another ID —
numbers must be unique across letters" — even though searching the full
student registry for S1546 showed nothing. Root cause, confirmed: a BVRIT
student already held an active bag coded "V1546". The owner's own staff
account is St Mary's-scoped, so the roster/search (`app/s/students/page.tsx`)
never fetches BVRIT rows at all — the colliding bag was real but structurally
invisible to the person trying to find it, which is exactly why "searching
the registry shows nothing" and "the system says it's taken" both felt true
at once.

**This was not a bug in the narrow sense — it was a previously deliberate
design, now reversed on the owner's explicit instruction.** `lib/bagcode.ts`
had carried, since Sep 2026, "one shared number line across every letter"
specifically because the owner asked for it then ("there cant be two 1001
like that... it should be continuous"). That design meant a bare number alone
(no letter) could unambiguously identify one bag campus-wide. The owner's
2026-10-19 request reverses it: St Mary's (S/B/G) and BVRIT (V) should be
independent namespaces — the same number may legitimately appear under both
letters — because in practice the shared pool meant a St Mary's registration
could be blocked by a BVRIT number staff structurally cannot see, with no way
to diagnose it from the UI. Recording this explicitly because it is the kind
of reversal this file's own header warns about: a future session must not
"fix" this back toward the old shared-pool behavior by pattern-matching the
Sep 2026 comments without reading this entry first.

**Changed**:
- `lib/bagcode.ts`'s `allocateBagCode`: the single `FySequence` row keyed
  `{kind:"bagcode", fyTag:"shared"}` is now one row PER LETTER
  (`fyTag: "B"|"S"|"G"|"F"|"V"`). Each letter mints independently. A
  defensive floor (new, not in the old design) seeds/bumps a letter's counter
  to at least the highest number any bag of that letter has EVER carried
  (live or not, computed in JS off the parsed number — a raw SQL `MAX(code)`
  would sort lexicographically and silently get this wrong once 3-digit and
  4-digit codes mix for one letter) — this makes the live migration off the
  old shared counter safe regardless of what it or existing rows contain; it
  can only move a letter's next number up to clear its own history, never
  down. Consequence worth stating plainly: BVRIT's first mint under the new
  scheme lands on exactly V1001 (owner, 2026-10-19: "give numbers for bvrit
  student from 1001") ONLY if production's live BVRIT bags don't already sit
  above 1000 — verified locally with a seeded V1546 bag, where the next
  auto-allocated BVRIT code correctly came back V1547, not V1001, because
  jumping backward to 1001 would collide with (or orphan the identity logic
  around) an already-printed, already-handed-out physical bag. **Whether
  production's real BVRIT roster already has V-codes above 1000 is unknown
  from this dev session — check `scripts/check-bagcodes.ts`'s output against
  production before assuming "starts at 1001" literally happens on first
  deploy.** If the owner wants EXISTING BVRIT students physically renumbered
  down to start at 1001, that's a separate, much bigger decision (reprinting
  bags already in students' hands) and was not attempted here.
- `lib/actions/admin.ts`'s `registerStudent`: deleted the cross-letter
  "numbers must be unique across letters" check entirely (lines formerly
  79-82). The exact-code check immediately above it (`${typedCode} is
  already in use`) is now the only check needed, and is sufficient on its
  own — once letters are independent namespaces, "is this exact code
  already live" is the entire invariant.
- `lib/actions/bags.ts`'s `setBagCode` (editing an existing student's
  customer ID): same deletion of the equivalent `numberClashCodes` check.
- `app/api/import/students/route.ts` (bulk sheet import): the single
  `usedNumbers` map (number → code, scanning every letter) is deleted; the
  post-import `FySequence` bump is now done per letter
  (`maxImportedByLetter`), matching the allocator's new per-letter scheme —
  this was the trickiest of the four call sites, since it previously tracked
  one running "highest number imported" across the whole sheet rather than
  one per letter.

**Verified**: proved the exact failure directly against a seeded local DB —
with a V1546 bag present, the OLD cross-letter query logic (re-run standalone)
confirmed it would have blocked S1546 exactly as the owner saw; the NEW
exact-code-only check does not. Full suite green (1188/1188 — net one fewer
than before because two now-contradictory old tests were replaced by one new
one asserting the opposite, correct behavior, rather than both an old and new
assertion existing side by side). `tsc --noEmit` clean. Five pre-existing
tests across `tests/bagcode-recycle.test.ts`,
`tests/register-student-walkin-id-behavioral.test.ts`,
`tests/bvrit-registration.test.ts`, `tests/owner-batch.test.ts`, and
`tests/customer-id-edit.test.ts` had encoded the OLD shared-pool behavior as
their expected outcome and were updated to assert the new per-letter
behavior instead, rather than deleted — a reversed business rule should
still have a test pinning down the new direction, the same discipline this
file's "CORRECTED + RESOLVED 2026-09-11" entry used for the payment-timing
reversal.

**Not done**: the registry/search gap that made the colliding V1546 bag
invisible to the St Mary's-scoped owner account is UNCHANGED —
`app/s/students/page.tsx` still scopes the roster query to the signed-in
staff's own `collegeId`, and the comment there frames this as deliberate
campus-walling, consistent with other screens. Now that numbers don't need
to be globally unique, the original reason to ever cross-reference the other
campus's roster from here is gone, so this is arguably no longer a gap at
all — flagging rather than changing it, since relaxing campus-scoping on a
roster/search view is its own decision with its own tradeoffs (a
St Mary's-scoped staff account seeing BVRIT students' names/phones) that
wasn't asked for.

**Lesson, generalizes**: a cross-letter/cross-scope uniqueness rule is easy
to get right in the code and easy to make undiagnosable in the UI if the two
scopes are never shown together anywhere — the bug here wasn't really in the
query, it was in the fact that nothing in the product could ever surface
"this number collides with something in a campus you can't see." Any future
uniqueness rule that spans more than one visibility scope (campus, college,
tenant, etc.) needs either (a) a search/lookup path that can see across that
scope for exactly this diagnostic purpose, or (b) uniqueness scoped to match
what's actually visible, which is the direction taken here.

## RESOLVED 2026-10-15: compensation_dupe_uniq's "unique" index never actually blocked its most common case (NULL orderId)

Found while setting up a fresh local dev environment (clone + fresh Postgres DB
+ seed) and running the existing test suite as a sanity check before declaring
"dev is ready" — not a new feature or a deliberate audit pass, just running
`npm test` on a clean environment surfaced a real, pre-existing production bug
that had apparently never failed CI.

**The bug**: `scripts/ensure-guards.mjs` installs `compensation_dupe_uniq`, a
partial unique index on `Compensation("studentId", "orderId", "complaintId",
kind)` meant to be the DB-level backstop behind `submitCompensation`'s
app-level `findFirst` duplicate check (`lib/actions/credits.ts`) — the comment
there explicitly says the `findFirst` read-then-write can race under Read
Committed isolation and the index is supposed to catch what it misses, same
pattern as `payment_gateway_ref_uniq` / `order_idem_key_uniq`.

Standard SQL unique-index semantics treat `NULL` as never-equal-to-`NULL` —
two rows with the same non-null columns but both `NULL` in a third column are
NOT considered duplicates by a plain `UNIQUE` index. `orderId` is the most
commonly-NULL column here: a compensation tied only to a complaint (the
ordinary "bad service" goodwill-credit case, no specific order involved) has
`orderId = NULL`. Two concurrent identical submissions for that exact case —
same `studentId`/`complaintId`/`kind`, both `orderId` NULL — sailed straight
through the "unique" index with zero violation. Proved directly: two manual
`INSERT`s with an identical key via `psql`, no error, both committed.

**Why it was invisible until now**: `tests/compensation-race-behavioral.test.ts`
exists specifically to catch this and does submit exactly the NULL-orderId
case — but the check in `ensure-guards.mjs` that decides whether to (re)create
the index only looked at `pg_indexes` for the *name* `compensation_dupe_uniq`,
not its actual definition. The index existed (just NULL-permissive), so every
run saw "already present" and skipped rebuilding it — which is also exactly
why a fresh-clone-and-seed environment was what surfaced it: the index gets
created once from scratch and then is presence-checked, never content-checked,
forever after. Whatever Postgres instance originally had this index built
(including, presumably, production) has carried the same silent gap since the
index was introduced, with nothing in CI or runtime ever exercising a genuine
concurrent double-submit against a NULL-orderId payout until this session's
`npm test` run on a brand-new environment happened to do the schema push +
guard install in the right order to make the pre-existing behavioral test
actually test something.

**Fixed** by adding `NULLS NOT DISTINCT` to the index definition (Postgres
15+; this project's deployed Postgres is already well past that) — this makes
two NULL `orderId`s compare equal for uniqueness purposes, same as any other
value. Also hardened `ensure-guards.mjs` itself so this class of gap can't
recur silently: the "does the index already exist" check now inspects
`pg_indexes.indexdef` for `NULLS NOT DISTINCT` rather than just the index
name, and drops + rebuilds a stale (NULL-permissive) index it finds, instead
of treating name-match as "nothing to do" forever. The duplicate-detection
query that runs before creating the index (`GROUP BY ... having count(*) > 1`)
was already correct — Postgres `GROUP BY` does treat NULLs as one group — so
no existing data is at risk of this migration refusing to apply.

**Verified**: local Postgres rebuilt from scratch, full suite green
(1189/1189, was 1188/1189 before the fix), `tsc --noEmit` clean.

**Not yet done**: this fix is only applied to the local dev database so far.
`scripts/ensure-guards.mjs` runs automatically on every `npm run build` /
deploy, so pushing this change and deploying will apply it to production
Postgres automatically — but that deploy has NOT happened yet (owner's
explicit per-deploy OK required first, per this project's standing rule).
Until deployed, production's `compensation_dupe_uniq` still has the old,
NULL-permissive definition, and a double-tap on a complaint-only (no order)
compensation in production is still exploitable the same way it was found
here. Treat shipping this fix as a real-money-correctness deploy, not a
routine one.

**Lesson, generalizes**: an idempotency script that checks "does a guard with
this NAME exist" instead of "does a guard with this CORRECT DEFINITION exist"
can only ever install its intended protection once, on the one environment
where it ran before the bug in its own definition was introduced or
discovered — every environment after that (including production, if the bug
predates it) silently inherits the broken version forever, with the script
itself reporting "already present" as if everything were fine. Any future
`ensure-guards.mjs` addition should diff the actual index/constraint
definition, not just its name, the same way this fix now does for
`compensation_dupe_uniq`.

## RESOLVED 2026-09-11 (late evening): missing busy-state guard on accept-order button

Staff order acceptance flow (OrderClient.tsx, line 951) was missing the 
busy-state guard present on every other state-changing button (collect, pay, 
refund, compensation). The "Accept order" button had no `disabled` attribute 
and the handler had no try/finally + busy flag — a double-tap would fire two 
concurrent `acceptOrder` calls. While acceptOrder does check `status !== "draft"` 
inside its transaction, the check runs on a stale read at line 150; under 
READ COMMITTED isolation both concurrent calls could read the same snapshot 
and both pass the check before either commits. Fixed by adding the same 
`acceptBusy` state, try/finally wrapper, and button-disabled pattern used 
everywhere else. The button now shows "Accepting…" during the request and 
is disabled to prevent re-taps.

**Symptom that would have surfaced**: a staff member double-tapping "Accept" 
on a slow network or under load would see both requests start, both would 
update the order, and depending on timing could result in duplicate audit 
entries or sheet rows for a single order accept.

## RESOLVED 2026-09-11: BVRIT rates UX, a genuinely missing busy guard, and two validation gaps

A round-3 pass covering data freshness, client-side cross-college leakage,
form validation, and a fresh-eyes UX walkthrough of the per-college rates
sheet. Freshness and cross-college leakage checked out clean (the `/s`
layout already declares `dynamic = "force-dynamic"`; every dropdown/select
sampled was correctly scoped). Three real fixes:

**Per-college rates sheet seeded from the wrong data for a first-time
campus.** Opening "Per-piece rates" on a campus with no existing override
(exactly BVRIT's situation) seeded the editor from the GLOBAL rates blob —
which for washFold/washIron carries their legacy multi-item, cycle-era
price lists (₹12/₹20, ₹15/₹25), nothing like a sensible per-piece starting
point, and also pulled in ironOnly/dryClean items that don't need
overriding at all. `resolveCollegeRates` merges per-SERVICE key, not
wholesale, so a campus's override only needs entries for the services it's
actually changing. Now seeds a fresh campus with just washFold (₹15) and
washIron (₹20), one line item each — exactly BVRIT's stated requirement,
nothing to delete or puzzle over. Tightened the sheet's copy to say
explicitly that only Wash & Fold/Wash & Iron are affected by the toggle.

**`createPayslip`'s button had no busy-state guard or try/catch at all** —
missed by every earlier button-handler sweep this session (all of which
checked `lib/actions/*.ts` and their existing callers, not a fresh grep for
NEW unguarded onClick handlers). An unhandled server error would leave the
button silently clickable with zero feedback, and nothing stopped a
double-tap from firing two `createPayslip` calls before the server's own
advisory-lock+duplicate-check even ran. Added the same disabled+try/catch/
finally pattern used everywhere else tonight. While fixing it, also noticed
the "Net pay" display clamped negative values to ₹0 via `Math.max(0, ...)`
— masking the actual computed number from the Owner instead of showing them
why the create button was about to be rejected. Now shows the true
(possibly negative, shown in red) value with an inline explanation, and the
submit button is disabled client-side to match the server's own
`net < 0` rejection — no more discovering the problem only after a
round-trip.

**Compensation amount had no client-side floor.** A staff member could
type a negative amount and only find out it was rejected after the
request round-tripped to the server (`lib/actions/credits.ts`'s own
`amount <= 0` check). Added `min={0}` to the input and disabled the submit
button while `comp.amount <= 0`, mirroring the payslip fix's same pattern.

Verified: 12 affected test files (291 tests, including one stale assertion
in `deep-audit-fixes.test.ts` updated to match the compensation button's
new guard condition) pass; tsc clean.

## RESOLVED + FLAGGED 2026-09-11: widened the "zero call sites" sweep beyond lib/actions

Extended the same audit to lib/*.ts (non-action helpers), every API route
in app/api/*/route.ts, every feature-flag/schema Boolean, and every staff
permission definition. Most of the codebase checked out clean — every
lib helper, feature flag, and permission has a real caller/UI toggle.
Two real findings:

**Fixed: `/api/export/statement` had no UI link.** The route itself was
fully correct (auth-checked, builds a real monthly-statement XLSX of
orders/payments/credit activity) but nothing in the customer app linked to
it — a student could never reach their own statement. Added a link to
`ProfileClient.tsx` next to the "Download my data" button added earlier
tonight.

**Flagged, NOT fixed: `/api/rt` (the SSE realtime stream) has zero client
subscribers anywhere in the codebase.** The server half is fully built —
`publish()` is called from ~15+ places across orders/bags/complaints/
credits/subscriptions, and the route itself correctly checks session
revocation (`liveSession()`, fixed earlier this session). But no component
anywhere opens `new EventSource("/api/rt")` — confirmed by grep, zero hits
for `EventSource` in app/ or components/. Every `publish()` call has been
broadcasting into an empty room since this was built.

**Deliberately NOT rush-fixed, unlike everything else tonight**: this is
genuinely different in kind from the "add a button" gaps found earlier.
Severity is real but bounded, not "the app is broken" — every action
handler already calls `router.refresh()` (47 call sites) to update the
actor's own view, and the thing a student actually needs to know without
having the tab open ("my order is ready") already goes through Web Push
(`pushNotif`, 21 call sites), a completely separate and already-verified-
working channel. What's actually missing is narrower: a second staff
terminal, or a student's OTHER open tab, doesn't update live without a
manual refresh. Wiring a correct EventSource client (reconnection on drop,
cleanup on unmount, routing incoming events to the right component state)
is real architectural work, not a 20-minute fix — building it hastily at
the end of a long session risks shipping a new, harder-to-spot bug class
(leaked connections, stale closures, a reconnect storm) in exchange for a
nice-to-have. Left for a dedicated session with the owner's explicit scope
sign-off rather than guessed at here.

Verified: tsc clean for the statement-link fix.

## RESOLVED 2026-09-11: systematic "zero call sites" sweep of every exported server action

Following the pattern of the night's earlier gaps (saveCollegeRates,
eraseStudentData — correct, tested actions with no UI calling them), ran a
systematic sweep: every exported function name in `lib/actions/*.ts` grepped
against `app/**/*.tsx` for at least one call site.

**Real gaps found and fixed** (all customer- or staff-facing, all missing
entirely from the UI):
- `grantFreeReservice` (complaints.ts) — free re-wash for a bad clean, a
  DIFFERENT remedy than monetary compensation (`submitCompensation`, which
  was already wired). Added a "Free re-service" button next to "Compensate"
  in `ComplaintsClient.tsx`; shows "Free re-service given" once one exists
  for that complaint (via `complaint.redoOrderId`, added to the page query).
- `eraseMyData`, `exportMyData`, `signOutEverywhere` (all student
  self-service, requiring their own session) — none had ANY button in
  `ProfileClient.tsx`. A student had no way to download their data (GDPR),
  erase their own account without visiting the counter, or remotely sign
  out a lost phone. Added all three, following the exact same
  confirm-then-toast-then-navigate pattern already used for logout/erase
  elsewhere tonight. Export downloads via a client-side Blob + temporary
  `<a download>` (server actions can't set Content-Disposition headers the
  way an API route can).

**False positives, checked and confirmed NOT gaps** (the sweep's own
methodology — grep app/ only — can't see calls from OTHER server actions,
or logic reimplemented directly in a server component instead of calling
the standalone action):
- `syncBagToPlan` — called from within `subscription.ts` itself (3 call
  sites), just never directly from a component. Correct as an internal
  helper.
- `todayClose` — its job (has today's shift already been closed?) is
  already done by `app/s/reports/page.tsx` querying `db.dayClose` directly
  and passing `closed`/`variance` as props to `CloseDayButton`. The
  standalone action duplicates that query and is genuinely unused, but
  nothing is missing — the UI already shows the right state.
- `cancelSubscriptionRequest` — dead code from a deprecated self-service
  subscription-REQUEST flow. `requestSubscription` (right above it in the
  same file) is already a permanent refusing stub with its own comment
  explaining plans are counter-only now; this is that stub's leftover
  "cancel my pending request" companion, from before that model existed.
  Nothing currently creates the state this would cancel.
- `listColleges` — genuinely has zero call sites anywhere in the codebase
  (not even other lib/ files), but no evidence any current flow needs it —
  registration passes `collegeId` via a fixed URL (`/join/bvrit`), not a
  dynamic picker. Left as-is; flagging here in case a future college
  selector needs it rather than reinventing the query.

Verified: 11 affected test files (251 tests) pass; tsc clean.

## CORRECTED + RESOLVED 2026-09-11: payment-timing restriction reverted; found the real cause of the missing bag code

Two follow-ups to the previous entry, from the owner testing further:

**Payment timing reverted.** The "pay only at ready/collected" restriction
added minutes earlier was based on my own inference of "pay at delivery,"
not what the owner actually wanted. The owner clarified explicitly:
students and staff should be able to pay before OR after delivery, no
restriction. Reverted the client-side condition in
`app/c/orders/[id]/page.tsx` back to its original "any non-draft,
non-cancelled status," and removed the server-side status guards from both
`createGatewayOrder` (`lib/actions/payments.ts`) and `payOrder`
(`lib/actions/orders.ts`) entirely — this was never deployed, so no
production impact. **Lesson**: a request phrased as "X should happen at
delivery" is not automatically "X should ONLY happen at delivery" — when a
business-rule fix restricts something, confirm the restriction direction
before shipping it, especially when it wasn't explicitly spelled out as
"only."

**Root cause of the missing V-series bag code, found.** `registerStudent`
(`lib/actions/admin.ts`) — used when STAFF add a student through the Admin
UI, as opposed to a student self-registering via WhatsApp — created the
Student row but never created a Bag. BVRIT's self-registration path
(`wa-register.ts`) auto-issues a complimentary V-series bag in the same
transaction as account creation; `registerStudent` never mirrored that. A
BVRIT student added by staff (exactly what the owner did, testing with
"shiva") ends up with zero Bag rows, so every UI that displays
`bags[0]?.code ?? student.id` (the students list, the customer detail
header) falls back to the raw 6-digit internal id — confirmed by the
owner's screenshot showing "ID 594277" instead of a V#### code.

Fixed by wrapping `registerStudent`'s student creation in a transaction
that also allocates and creates a BVRIT bag when the target college is
BVRIT (name-matched, same pattern as `requireCyclesEnabled`'s BVRIT check),
mirroring `wa-register.ts` exactly. Also fixed the success toast in
`HomeClient.tsx`, which showed the raw internal id even for a student who
DID get a bag code from self-registration — now shows the bag code when
one exists. Also corrected a stale top-of-function comment claiming
`registerStudent` was "the ONLY way a student account is created," which
stopped being true the moment WhatsApp self-registration shipped.

**"shiva" (id 594277) in production still has no bag** — this fix only
prevents the bug for future registrations. The owner needs to either issue
a bag manually via that student's "Issue complimentary bag" button, or
erase the test account (now possible via the Danger Zone added minutes
earlier) and re-register to get a clean V#### code automatically.

## RESOLVED 2026-09-11: three real gaps found by the owner testing production directly

The owner registered a real test BVRIT student and reported four things not
working as expected. Investigating each against actual code (not assumption)
found three genuine gaps — all UI/wiring gaps, not logic bugs in the
already-tested server actions:

**1. BVRIT was billing by cycle, not per piece.** `lib/money.ts`'s
`collegeUsesCycleBasedPricing` is correct — it returns per-piece pricing the
moment `College.rates` is set for that college. But `saveCollegeRates` and
`saveCollegeExpressRates` (`lib/actions/admin.ts`) existed as fully working,
already-tested server actions with **no UI anywhere calling them** — not
even a button. `app/s/admin/page.tsx` was already passing `rates` through to
`AdminClient`'s `colleges` prop (someone had started this and stopped), but
the Props type didn't declare it and no sheet/form existed. Built a
"Per-piece rates" button on each college card in `AdminClient.tsx` opening a
sheet that edits and saves via `saveCollegeRates` — same shape as the global
rates editor, but (deliberately, unlike the global one) does NOT hide
washFold/washIron item editing, since per-piece pricing for those two
services is the entire point of the override.

**2. No way to delete/erase a student account.** `eraseStudentData`
(`lib/actions/privacy.ts`) — the anonymization function fixed and tested in
an earlier pass this same session (it now correctly blocks erasure while an
order is in-flight) — was never called from any button anywhere in the app.
Added a "Danger zone" section to the staff customer-detail page
(`CustomerClient.tsx`, Admin+ only) with a reason-required confirmation
sheet.

**3. Students could pay right at drop-off, not just at delivery.** The
owner's rule is payment happens when the clothes are handed back. The Pay
button was showing for ANY non-draft/non-cancelled status (i.e. as soon as
staff accepted the order), and — worse — the underlying server actions
(`createGatewayOrder` in `lib/actions/payments.ts`, `payOrder` in
`lib/actions/orders.ts`) had NO status check at all, only a client-side hide.
Fixed both: the button now only shows at `ready`/`collected`, and both
server actions now reject payment attempts outside that window even via a
direct call. `recordPay` (staff, at the counter) is deliberately left
unrestricted — staff discretion at the counter is a different thing from the
student self-service flow.

**4. Missing V-series bag code — unresolved, needs the owner's input.** The
registration flow (`wa-register.ts`) is supposed to auto-mint a `V####` bag
code the instant WhatsApp verification completes, in the same transaction as
account creation. Couldn't reproduce or disprove this without knowing
exactly which screen the owner was looking at — if `student.bags` is empty
for that account, `CustomerClient.tsx`'s "No active bag" state matches what
would be seen if bag creation genuinely failed (e.g. the wrapped transaction
rolled back for some reason); if bags exist, the code shows fine. No
production DB access this session to check directly — needs the owner to
either point at the screen they looked at, or a session with DB access to
query `Bag` rows for that student id.

**Lesson**: every audit pass this session searched CODE for bugs (races,
missing guards, error handling). None of them would ever catch "the
correct, tested server action has no UI calling it" — that class of gap is
invisible to code review because there's no broken code to find, just an
absent button. Only using the actual product the way a real user does
surfaces it. Worth periodically asking the owner (or a UI-walkthrough pass)
to click through every screen, not just auditing source.

## RESOLVED 2026-09-11 (pass 20): complaint photo preview silently failed to load before submission

**File**: `app/c/help/_components/HelpClient.tsx`
**Issue**: When a student uploaded a photo in the complaint form, the preview image failed to load with a 401 error. The preview used `/api/complaint-photo?key=...` to display the uploaded photo, but that endpoint checks `mayView()` to ensure the photo key exists on one of the student's own ComplaintMessage rows. Before the complaint is submitted, no ComplaintMessage exists yet, so the ownership check fails and returns 401. The student could upload photos successfully but couldn't see previews until after submitting the complaint (and then refreshing), creating a confusing UX where users couldn't confirm what they were uploading.

**Root cause**: The photo preview flow tried to reuse the same authorization-gated endpoint as the post-complaint display, instead of using a method that didn't require server ownership checks.

**Fixed by**: Switched from server-based preview to client-side blob URLs. When `compressImage` completes, the function now creates a `URL.createObjectURL()` blob URL from the compressed file and stores both the server upload key and the blob URL as a `{key, preview}` pair. The preview displays the blob URL (no server round-trip), and submitting sends the keys to the server. Blob URLs are cleaned up (via `URL.revokeObjectURL`) when photos are removed or when submission completes, preventing memory leaks. This works because the File object (and its compressed version) is already available in memory on the client, so a local preview is instant and requires no server auth.

**Verified**: TypeScript clean, photo preview now displays immediately after successful upload, no broken images before submission.

## CORRECTED 2026-09-11: pass 19's error-message sanitization swallowed real validation messages

Pass 19's fix for raw-error-leakage in `acceptOrder`/`placeOrder`/`issueBag`/
`syncBagToPlan` used a keyword-substring allowlist (`msg.includes("Not
enough")`, `msg.includes("already")`, etc.) to decide which caught error
messages were safe to show the user. Checking every actual `throw new
Error(...)` site inside each function's `try` block found this allowlist
was incomplete: `acceptOrder` can throw `"Unknown item " + label`, `"Pick at
least one cycle"` / `"Add at least one piece"`, and — worst of all — the
`requireCyclesEnabled` gate's rejection message (the "BVRIT bills per piece,
cycle plans are never sold here" business rule the owner has repeatedly
insisted on). None of those contain any of the allowlisted words, so they
were all being silently replaced with a useless generic "please try again",
hiding exactly the information a student or staff member needs.

Fixed by switching the filter from keyword-matching to what the codebase
already uses everywhere else to distinguish an internal error from a
deliberate business-validation throw: a genuine Prisma/internal error always
carries a `.code` property (e.g. P2002); a `throw new Error("...")` written
by this codebase's own validation logic never does. `!(e as {code?:string}).code`
is a complete, robust test — every legitimate validation message passes
through untouched, and only real internal errors get the generic message.
Also caught (while re-running the tests this touches) that the same commit
had removed a legitimate server-side-only `console.error` in
`syncBagToPlan`, breaking `tests/customer-id.test.ts`'s assertion that it
still logs failures for diagnosability — restored it (it carries no PII,
unlike the WhatsApp-webhook log this same pass correctly removed).

**Lesson**: a fix framed as "make error messages safer" needs the SAME rigor
as a concurrency fix — enumerate every actual throw site inside the guarded
block and verify each one is preserved, don't reason abstractly about "known
error keywords." An allowlist is only as good as its enumeration, and this
one silently regressed the exact BVRIT business rule this session has
fixed and re-verified multiple times already.

## RESOLVED 2026-09-11 (pass 19): debug logging, error message leaks, missing loading states

Audit pass 19 focused on three fresh angles: error message consistency
(staff actions), debug logging for data leaks, and UX completeness (loading
states). Found:

### (1) Console logging in WhatsApp webhook — data leak risk
**File**: `app/api/whatsapp/webhook/route.ts:93`
**Issue**: Production webhook endpoint logged inbound phone numbers and message
content (first 80 chars) to console on every message:
```
console.log(`[wa-inbound] from=${from} type=${msg.type} text=${...}`)
```
These logs flow to Render's log stream, where they persist longer than
necessary. The phone number is user PII; if a message ever contains sensitive
data (OTP, verification code, etc.), it would be exposed there. Logging
debug info in a webhook serving as part of the auth flow is unnecessary risk.

**Fixed by**: Removed the console.log statement entirely. The webhook handler
doesn't need to log every inbound message — errors are logged separately if
they occur.

### (2) Raw exception messages returned to clients — internal details leak
**Files**: `lib/actions/orders.ts` (lines 123, 264), `lib/actions/bags.ts`
(lines 111, 196)
**Issue**: Catch blocks returned `(e as Error).message` directly, exposing
internal error details to the client. Database constraint violations (P2002),
query errors, or business-logic exceptions would leak raw text like:
- "Unique constraint failed on the fields: (studentId_status)"
- Raw Prisma error text
- SQL details if a raw query failed

These violate the error-message consistency already established elsewhere
in the codebase (specific, user-facing messages).

**Fixed by**: Sanitized all three catch blocks. Messages containing known
user-facing keywords ("Not enough", "already", "active bag", "not found") pass
through; all others return a generic, safe message like "Failed — please try
again". This preserves intentional, actionable errors while hiding internals.

### (3) No loading states on data-heavy pages — UX blank-screen problem
**Files**: `app/s/reports/page.tsx`, `app/s/students/page.tsx`,
`app/s/orders/[id]/page.tsx`
**Issue**: These pages perform multiple sequential database queries in server
components with no Suspense boundaries or loading.tsx files. If a query takes
>1s (not rare on slow connections or busy DB), users see a blank white screen
with no indication that data is loading. This violates Next.js best practice
for server-side rendering.

**Fixed by**: Added `loading.tsx` skeleton UI files for all three pages:
- `app/s/reports/loading.tsx` — shimmer cards for stats and charts
- `app/s/students/loading.tsx` — list skeleton for roster
- `app/s/orders/[id]/loading.tsx` — order details skeleton

The skeleton uses existing design tokens (var(--muted)) and matches the
expected layout, so the page feels responsive even during load.

**Lesson**: Raw exception messages are not tests — they don't validate your
input, they just leak your implementation. Consistent error messages are part
of the UX contract, not a side effect of error handling. And "the server
works offline" is not an excuse for a blank screen; modern web UX expects
feedback even before the HTML lands.

## RESOLVED 2026-09-11 (pass 18): form labels missing htmlFor/id, buttons missing accessible names

Audit pass 18 checked the three most business-critical customer-facing pages
(login, BVRIT registration, order placement) from an accessibility angle —
a lens not yet used in 17 prior passes. Found:
- `app/login/_components/LoginForm.tsx`: 3 `<label>` elements (phone, passcode,
  OTP) had no `htmlFor`, and their `<input>`s had no matching `id` — a screen
  reader announces these inputs with no name at all.
- `app/join/bvrit/_components/RegisterForm.tsx`: same gap on the name field.
- `app/c/order/new/_components/OrderNewClient.tsx`: the cycle and per-item
  quantity +/- buttons only contained a bare "−"/"+" glyph with no
  `aria-label`, so a screen reader announces "minus button" / "plus button"
  with no indication of what's being adjusted. Slot-selection buttons already
  had visible text but no `aria-pressed`, so the selected state (conveyed only
  by background color) was invisible to assistive tech.

Fixed by adding `id`/`htmlFor` pairs to all 4 labels, `aria-label` to the 4
quantity buttons (2 generic "Decrease/Increase cycles", 2 per-item with the
item name interpolated), and `aria-pressed` to the slot buttons. Verified the
phone-input label/id pairing live via a local dev server + JS DOM query
(`document.getElementById(label.htmlFor)` resolves correctly).

**Lesson**: every prior pass used the same lens (server-side races, atomic
guards, transaction timeouts). A genuinely different lens — here,
accessibility — found a class of bug 17 passes of the same pattern-matching
approach would never surface. Worth periodically switching the angle of
attack rather than only deepening the same search.

## RESOLVED 2026-09-11 (pass 17): Sheets sync silently ignored tab write failures

Deep audit of Sheets integration found that every call to `writeSheet()` in
`lib/sheets-sync.ts`'s `runSheetsSyncUnsafe()` function was awaited but its
return value was never checked. The function returns `{ ok: boolean, error?: string }`
per the API contract (lib/sheets.ts lines 147, 153), so:

- If writeSheet("Daily") failed with a network error, `result.ok` would be false
- The error was silently ignored, and the code continued to call writeSheet("Plans")
- Earlier tabs (Live, Daily) that succeeded stayed in Google Sheets
- The final return statement claimed all tabs succeeded: `tabs: ["Live", "Daily", "Plans", ...]`
- The caller (Admin "Sync now" button) was misled into thinking the full sync worked

Fixed by:
1. Capturing the result of every writeSheet call
2. Throwing an error immediately if any tab write fails (line 125, etc.)
3. Updating writeStudentsTab to return `{ ok: boolean, error?: string }` so the
   caller can check it
4. Updating runRosterSync to check writeStudentsTab result and propagate errors
5. Test-locking the fix: tests/sheets-error-handling.test.ts verifies that failed
   writes are caught and error messages identify which tab failed (not generic)

**Root cause, same pattern as other audit-pass findings**: fire-and-forget or
unchecked async calls accumulate silently. The sheet sync runs infrequently
(nightly + manual button), so this would only surface if Google Sheets became
unreachable mid-sync. A network blip during "Sync now" would now error clearly
instead of claiming success while leaving some tabs stale.

## RESOLVED 2026-09-11 (pass 16): 6 atomic-double-submit bugs in bag/plan/wallet operations

Systematic audit on CustomerClient.tsx handlers and their underlying server-side
actions found and fixed six bugs where concurrent calls to the same operation
could either double-charge a student or send duplicate notifications:

### UI-level bugs (missing busy-state guards):

1. **doReissue (CustomerClient line 155)**: No busy-state guard. The button can
   be clicked multiple times in rapid succession, firing multiple concurrent
   `reissueBagSameCode` calls. Added `reissueBusy` state, try/finally guard,
   and button disable. Same pattern as the existing `bagBusy`, `tuLoading`, etc.

2. **doReleaseBag (CustomerClient line 215)**: No busy-state guard. Same gap as
   doReissue. Added `releaseBusy` state, try/finally guard, and button disable.

### Server-side atomicity bugs:

3. **reissueBagSameCode (bags.ts line 219)**: 
   - Pre-check at line 224 runs outside transaction
   - Two concurrent calls both pass, both try to create active bag with same code
   - Second call's create hits unique constraint (P2002) and threw unhandled error
   - Fixed by: (a) adding try/catch for P2002 with friendly message, (b) adding
     atomic re-check inside transaction to catch stale reads. Now if bag.status
     changed between the check and the transaction, the error is caught and
     reported cleanly.

4. **releaseBagCode (bags.ts line 346)**:
   - Pre-checks at lines 351-364 all run outside transaction
   - Two concurrent calls both pass all checks, then both update the bag
   - Second caller sees success even though bag was already released
   - Fixed by: replacing unconditional update with atomic `updateMany({where:
     {status: {not: "released"}}})` and checking affected count. Now only the
     first caller's update matches and commits; second gets "already released".
     Same pattern as retireBag (line 387) which was already using this correctly.

5. **upgradeSubscription (subscription.ts line 291)**:
   - Pre-check at line 310 runs outside transaction (`cur.planId === plan.id`)
   - Two concurrent upgrade attempts to the same plan both pass the check
   - Both acquire the advisory lock sequentially and both execute the update
   - Both create a Payment row, charging the student twice for one upgrade
   - Fixed by: re-checking inside the transaction (after the lock, fresh read)
     that `fresh.planId !== plan.id` before proceeding. Second caller throws
     "already on that plan" instead of creating a duplicate Payment.

6. **cancelSubscription (subscription.ts line 393)**:
   - Pre-check at line 406 runs outside transaction
   - Two concurrent cancels both pass it
   - Both call update and both send pushNotif/audit/notifyOwner calls
   - Results in duplicate notifications to student and owner
   - Fixed by: replacing unconditional update with atomic `updateMany({where:
     {active: true}})` and checking affected count. Now only first caller
     updates and notifies; second gets "already inactive" error. Same pattern
     as collectOrder's atomic status transition (orders.ts line 568).

**Root cause, pattern from earlier passes**: When a function reads a precondition
outside a transaction, then does an unconditional write inside (or no transaction
at all), two concurrent calls can both pass the check and both write, corrupting
state or duplicating side effects. The fix is ALWAYS: either move the check
inside the transaction and re-check after acquiring a lock/re-read, OR use
`updateMany` with the precondition in the WHERE clause and check affected count.
This session found six instances; all now follow this pattern consistently.

**Not fixed (already correct)**:
- OrderClient.tsx handlers (handleCollect, handlePayCash, handlePayUpi) — all
  have actionBusy guards and their server-side actions (collectOrder via
  updateMany; recordPay via payCore's P2002 unique-index backstop) are safe.
- lib/bagcode.ts allocateBagCode — recycled-code race is intentionally handled
  by P2002 collision + retry loop (issueBag lines 69-113), documented as working.
- app/api/import/students bulk import — concurrent overlapping phone numbers
  correctly get P2002 constraint violation, caught as per-row error (line 196).

## RESOLVED 2026-09-11 (pass 15): 3 race/atomicity issues in closeDay, erasure, compensation

Systematic audit on ReportsClient.tsx, ops.ts closeDay, privacy.ts erasure, and
credits.ts submitCompensation found and fixed three issues:

1. **closeDay double-close creates duplicate DayClose rows.**
   The pre-check `if (await db.dayClose.findUnique(...))` ran outside a
   transaction. Two concurrent "Close day" button taps both passed the check,
   then both attempted `db.dayClose.create()`. The second hit Postgres's
   unique constraint on (date) and threw an unhandled P2002 error, unlike
   `clockIn()` (line 26) which catches and returns a friendly message.
   
   Fixed by adding a P2002 catch block to `closeDay()` (ops.ts line 77-81),
   following the same pattern as `clockIn()`. Now the second tap gets a
   friendly error instead of a crash. Verified by test that races only create
   one DayClose row.

2. **eraseStudentData/eraseMyData break SMS and pickup OTP for active orders.**
   Anonymizing a student's name/phone while they have an order in-flight
   (status="received" or "processing") breaks SMS notifications and the
   pickup OTP collection flow. The phone field becomes "deleted-{studentId}",
   which is not a valid number to dial. The check `if (stu.anonymisedAt)`
   was outside the transaction and vulnerable to concurrent calls.
   
   Fixed by adding a pre-transaction check `if (activeOrder)` to both
   `eraseMyData()` and `eraseStudentData()` (privacy.ts) to reject erasure
   while an order is in-flight. Customers are told to wait for collection
   first. Verified by test that erasure is blocked when active order exists.

3. **submitCompensation double-submit creates duplicate payouts.**
   The compensation sheet uses `actionBusy` UI-level guard, but no server-side
   idempotency check. Two compensation requests for the same incident (same
   orderId/complaintId/kind) could both succeed and create two separate
   compensation records. Database has no unique constraint to prevent this.
   
   Fixed by adding a transaction-level check in `submitCompensation()`
   (credits.ts line 27-31): before creating, check if a compensation with
   the same (studentId, orderId, complaintId, kind) already exists, and
   throw "already issued" if so. Different kinds for the same order are
   allowed. Verified by test that duplicate same-kind compensations are
   rejected but different-kind compensations succeed.

**Verified:** All three fixes are test-locked (`audit-15-double-close-erase-comp.test.ts`),
type-check clean, and pass integration tests.

## RESOLVED 2026-09-11 (pass 14): 3 concurrent-request issues in complaints and UI

Audit sweep on complaint-handling logic found and fixed:

1. **resolveComplaint could be called twice and send duplicate notifications.**
   The function checked if the complaint was open, then called `db.complaint.update()`,
   but the check-then-act was not atomic. Two concurrent calls (or a retried request
   while a response was pending) could both pass the status check and both update,
   resulting in two calls to `pushNotif()` and two duplicate messages to the student.
   
   Fixed by adopting the atomic pattern already used by `grantFreeReservice`: 
   use `db.complaint.updateMany({ where: { id, status: "open" }, data: {...} })`
   and check `if (claimed.count === 0)` to detect and reject the second caller.
   This is now a test-locked invariant in `deep-audit-fixes.test.ts`.

2. **ComplaintsClient send/resolve buttons had no busy-state guards.**
   While `doComp` (compensation) had busy-state tracking to prevent double-tap,
   `send` (message) and `doResolve` (resolve complaint) had no guard, making duplicate
   message/resolution calls possible if a user clicked rapidly or on slow networks.
   
   Fixed by adding `sendBusy` and `resolveBusy` state (following the pattern of
   `compBusy`) and disabling the buttons/inputs while in-flight. Messages show
   "Sending…" / "Resolving…" to signal the state to the user.

3. **Fire-and-forget sendWhatsAppPhotos calls had no catch handlers.**
   Two calls to `void sendWhatsAppPhotos()` in complaints.ts (lines 80, 112)
   lacked `.catch(() => {})` handlers. While the function is designed not to
   throw, adding explicit catch handlers provides defense-in-depth to prevent
   any unexpected errors from becoming unhandled rejections.

**Verified:** All three fixes are test-locked (`deep-audit-fixes.test.ts`),
type-check clean, and pass the full complaint-related test suite.

## RESOLVED 2026-09-11 (pass 13): 6 non-advisory-lock transactions missing the 15s timeout bump

Found by systematic sweep for every `db.$transaction(` call in `lib/actions/*`
and `lib/sheet-events.ts`: the lessons from the advisory-lock timeout timeout
bugs (pass 12, same day) also apply to row-locked and external-call
transactions. Six functions had default 5s Prisma timeout but legitimately
could exceed it under concurrent load or when calling external services:

- `collectOrder` (line 559 in orders.ts): calls `enqueueSheetEvent`, which
  makes a real Google Sheets API call INSIDE the transaction. Sheet API
  latency of 3-5s under load + holding a write lock on the Order row can
  easily exceed 5s total.
  
- `payInner` (line 608 in orders.ts): identical issue — `enqueueSheetEvent`
  + multiple Payment/CreditUse/Student/Invoice writes in sequence.
  
- `cancelOrder` (line 865 in orders.ts): calls `restoreCycleFor`, which
  locks the Subscription row. Two concurrent cancels can queue the second
  one behind the first's lock, same pattern as the advisory-lock fixes.
  
- `refundOrder` (line 708 in orders.ts): locks the Order row, then may call
  `restoreCycleFor` (which locks Subscription), or `createCreditNote`.
  
- `activateSubscription` (line 165 in subscription.ts): locks Subscription row +
  re-reads + creates Payment. Concurrent activation attempts queue.
  
- `upgradeSubscription` (line 322 in subscription.ts): locks Subscription row +
  re-reads + creates Payment. Concurrent upgrades queue.
  
- `adjustCycleUsage` (line 90 in subscription.ts): locks Subscription row +
  re-reads + updates. Concurrent corrections queue.

All now use `{ timeout: 15_000 }`, matching the pattern. The 15s value accounts
for a single queued row lock PLUS a reasonable external API latency (Sheets).

**Lesson, same root cause as advisory-lock fixes**: timeout bumps are per-call-site,
not per-mechanism. An advisory lock needs 15s, a row lock needs 15s, an external
call needs 15s — but the pattern is invisible if you only look at one type. A
grep for `db.$transaction(` that documents EVERY call site's timeout (or lack
of one) and its risk level is the only way to close this class of bug
systematically, not just the instances that fail during the current test run.

## RESOLVED 2026-09-11: 4 advisory-lock transactions missing the 15s timeout bump

Caught by a genuine (non-contention) full-suite failure: `sellCyclePack`'s
behavioral test threw a real Prisma error —
`Transaction API error: A commit cannot be executed on an expired
transaction. The timeout for this transaction was 5000 ms, however 6161 ms
passed since the start of the transaction.` This is the exact failure mode
`acceptOrder`/`walkInOrder` were already bumped to `{ timeout: 15_000 }` for
(2026-09-05): a `pg_advisory_xact_lock` makes a concurrent caller queue
behind the lock holder, and Prisma's default 5s interactive-transaction
timeout can expire while still queued — especially on this project's
higher-latency remote test DB, but the same risk exists in production under
real concurrent load.

Grepped every `pg_advisory_xact_lock` call site and found the 15s bump had
only ever been applied to `acceptOrder`/`walkInOrder` — 4 other advisory-lock
transactions still had the bare 5s default:
- `subscription.ts` `assignSubscription` (line ~256)
- `subscription.ts` `sellCyclePack` (line ~539) — the one that actually failed
- `admin.ts` `createPayslip` (line ~481)
- `bags.ts` `issueBag` (line ~106)
- `orders.ts` `placeOrder` — wraps `slot-capacity.ts`'s advisory lock, same exposure

All 5 now use `{ timeout: 15_000 }`, matching the existing pattern. Verified:
`tests/subscription-first-time-race-behavioral.test.ts`,
`tests/payslip-race-behavioral.test.ts`, `tests/bag-race-behavioral.test.ts`,
and `tests/slot-capacity-race-behavioral.test.ts` all pass together.

**Lesson, same shape as several others this session**: when a fix pattern is
applied to fix ONE instance of a bug, grep for every other call site sharing
the same root mechanism (here: `pg_advisory_xact_lock`) before considering
the class closed — the original 2026-09-05 fix only touched the two spots
that had an active test catching it at the time, not every spot with the
same underlying exposure.

## RESOLVED 2026-09-11 (pass 12): College.expressRates was declared but never writable

Deep-audit pass for "checked but never written" bugs (following the pattern of
the WaVerify.studentName fix this same session) found that `College.expressRates`
was added to the schema in commit eef0e24 (BVRIT per-college pricing, Oct 2026),
declared as:
```
expressRates  Json? // per-college express (same-day) flat-fee override; null = use global EXPRESS_FLAT
```

The field is **read** in `lib/actions/orders.ts` line 36-41 as an override for
express-service pricing, identical to how `College.rates` works for regular
pricing. However, there was **no `saveCollegeExpressRates` function** to let an
admin actually SET this field — unlike `saveCollegeRates` which exists for the
`rates` field. The feature was prepared (schema + read path) but never exposed
for configuration.

Fixed by adding `saveCollegeExpressRates(collegeId, expressRates)` to
`lib/actions/admin.ts`, following the exact same pattern as `saveCollegeRates`:
accepts a `Record<string, number>` or null (to clear), enforces Admin+ auth
and campus isolation, audits the change, and writes to the College row via
Prisma.

**Lesson, same as the WaVerify case this session**: when a schema field is
added as a configuration override (nullable Json with a comment explaining
the intended value), the write path MUST exist. A field that is only readable
is a schema declaration with no implementation — either remove it or implement
the setter. Grep for the field name + "json\|Json" in the schema comment to
find other overrideable config, and verify each has a matching function to set
it in `lib/actions/admin.ts`.

## RESOLVED 2026-09-11 (pass 12): WaVerify.studentName registration hijacking fix re-verified

Confirmed the WaVerify registration hijacking fix from pass 11 is complete
end-to-end: `studentName` is WRITTEN at registration start in
`startWhatsAppRegister` (line 80, `data: { studentName: name, ... }`) and
READ/enforced in `checkWhatsAppRegister` (line 128, `if (!row.studentName)
return error`), plus both test files exist and pass: `wa-register-name-behavioral.test.ts`
and `bvrit-registration.test.ts`. No gaps found.

## RESOLVED 2026-09-11 (pass 8): staff attendance clock-in/out race conditions

Audit pass 8 found two related race conditions in `lib/actions/ops.ts`:

**clockIn (line 15-23)**: A staff member double-tapping the "Clock In" button could 
trigger two concurrent requests, both bypassing the `findUnique` check, both attempting 
to create an `Attendance` record for the same `(staffId, date)`. The second request would 
hit the unique constraint and throw an unhandled Prisma P2002 error instead of returning 
a friendly "Already clocked in" message like the sequential case does. The fix mirrors 
the pattern used in `registerStudent` and `updateStudentPhone`: wrapped the create in a 
try/catch that converts P2002 to a user-friendly error message.

**clockOut (line 25-35)**: Two concurrent clock-out requests both pass the initial checks,
but the update itself was unconditional — the second concurrent request would silently
overwrite the first's `clockOut` timestamp with its own. While this doesn't cause data 
loss (just two timestamps ~milliseconds apart for the same moment), it's better to be 
explicit: changed to use `updateMany` with a WHERE condition `clockOut: null`, so only 
the first request to set `clockOut` wins, and the second gets a clear "Already clocked out" 
error.

Both fixes follow patterns already established elsewhere for similar races. Verified 
with a new behavioral test (`tests/attendance-race-behavioral.test.ts`) that simulates 
concurrent clock-in/out attempts. Full suite status: pending completion.

## RESOLVED 2026-09-11 (pass 6): timezone bug in daily report email label and payslip month form

Audit pass 6 (deep re-check on fresh ground) found two timezone mismatches on
the UTC server:

**report.ts line 167 (email subject/cash summary label)**:
`const todayLabel = new Date().toLocaleDateString(...)` did not specify
`timeZone: "Asia/Kolkata"`, so at IST day boundaries (UTC 2024-03-31 23:00 is
IST 2024-04-01 04:30), the label would show the wrong calendar date
(2024-03-31) while the actual report was already computing IST 2024-04-01.
Fixed by adding `timeZone: "Asia/Kolkata"` to match the other date displays
in the same function.

**AdminClient.tsx line 101 (payslip month selector initialization)**:
`month: new Date().toISOString().slice(0, 7)` initialized the form field to
the UTC date, not IST — at month boundaries, the form could show the previous
month while the user intended the current (IST) month. Fixed by using
`istDateStr(Date.now()).slice(0, 7)` instead, same pattern as report.ts.

Both are display-only (not business logic), and both manifested at IST
day/month boundaries only — UTC servers are standard cloud practice, so this
class of bug should be caught during any refresh of date handling. Both fixes
follow patterns already established elsewhere in the codebase.

## RESOLVED 2026-09-11 (pass 6): verified BVRIT pricing gate and concurrent registration safety

Sixth audit pass systematically checked four high-risk areas:

**1. BVRIT vs St Mary's pricing boundary**: Confirmed all four cycle-sale
paths (`assignSubscription`, `upgradeSubscription`, `activateSubscription`,
`sellCyclePack`) call `requireCyclesEnabled` as their first check after
`assertSameCollege`. The gate enforces three conditions: (a) explicit name
match on "BVRIT" as a safety net, (b) rate-override check (`college.rates !=
null`), (c) feature flag check. Verified no alternative cycle-sale paths
exist (no bulk imports, no admin overrides, no walk-in surcharges). The rule
is enforced consistently and no side doors found.

**2. Concurrent phone registration**: Both `registerStudent` (staff counter)
and `checkWhatsAppRegister` (BVRIT self-reg) correctly handle the phone
unique-constraint race — `registerStudent` wraps the create in a P2002 catch
(lines 40-45 in admin.ts), `checkWhatsAppRegister` marks the WaVerify row
"claimed" atomically before creating the account, and reverts on error (lines
135-139, 196 in wa-register.ts). No duplicate Student rows can be created for
the same phone.

**3. Timezone/date boundaries**: Deep grep found the two issues above (fixed).
All other date computations use either `istToday()` or the explicit
`+5.5h` offset pattern correctly. The reported pattern ("bare `new Date()`
followed by `.slice(0,10)` without IST offset") appeared in no business-logic
code paths — only in transaction timestamps (when something happened), which
are correctly UTC-absolute.

**4. advanceStatus fix (pass 1, commit 0cfee20)**: Independently re-reviewed
the first agent's fix. The change is correct: moved from loose unguarded db
calls to a transaction using `updateMany({ where: { id, status: o.status },
... })` with an affected-count check, identical pattern to `collectOrder` and
`cancelOrder` (both fixed earlier 2026-09-05). The piece-count update moved
into the transaction's data object, ensuring atomicity. Behavioral test
confirms only one concurrent call wins and exactly one pickup OTP exists
afterward. No logic bugs detected in this fix.

## RESOLVED 2026-09-11: service-worker cache version not bumped on 20+ client-side deploys

Found during a PWA audit (PART 2 pass 2026-09-11): the `CACHE` constant in
`public/sw.js` was still `"ff-v33"`, last bumped on 2026-09-04 (`fd10fa7`).
Between that commit and 2026-09-11's HEAD, 20+ commits touched client-side
TypeScript/TSX files (LoginForm, PayClient, OrderDetailClient, AdminClient,
OrdersClient, etc.), all of which get compiled into Next.js bundles served from
cache. Users who had cached the old bundle would continue using it across these
deploys instead of fetching the new code — a silent cache-invalidation failure.

**Root cause**: the pattern of "bump cache version on deploy" was established
in git history (`adb8510`, `1108c5d`: "Bump service-worker cache to ff-v15/v22
for this deploy") but became a manual discipline that wasn't applied to recent
deployments. No automation enforces it.

Fixed by bumping to `ff-v34` in `public/sw.js`. The next `npm run build`
creates new hashes for all bundles, and users will fetch them because the
service worker's own cache key changed.

**Lesson, same root cause as other discipline gaps this session**: a manual
deploy checklist step (like "did we bump the cache version?") needs to be
either (a) automated into the build process, or (b) explicitly called out in
commit messages + PR description so reviewers catch it. Neither happened here.

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

## RESOLVED 2026-09-05: cron/report routes used plain-string secret comparison, unlike this codebase's own webhook standard

Checked every `CRON_SECRET` comparison site for the same class of gap this
codebase's webhook routes (Razorpay, WhatsApp) already defend against with
`crypto.timingSafeEqual`. Found eight: `app/api/cron/collection-reminders`,
`error-digest`, `purge-photos`, `weekly-digest`, `app/api/backup`,
`app/api/report/daily`, `app/api/sheets/flush`, and `app/api/sheets/sync`
all independently duplicated `auth === \`Bearer ${secret}\`` as a plain
string comparison. The webhook routes' own comments explain exactly why
this matters even when the timing side-channel is impractical over real
network jitter: it costs nothing to close, so close it.

Consolidated into one shared helper, `lib/cron-auth.ts`'s `isCronRequest()`
— `crypto.timingSafeEqual` with a length check first (the same
"timingSafeEqual throws on a length mismatch" trap every other timing-safe
check in this codebase documents), returns `false` rather than throwing
when `CRON_SECRET` isn't configured at all. Applied to all eight route
files, replacing each one's own duplicated comparison. Centralizing this
also closes the actual root cause, not just the eight known instances: a
future cron/report/backup route gets the timing-safe check for free by
importing the helper, instead of the lesson needing to be re-learned (or
missed) the ninth time.

Verified with a new unit test suite (`tests/cron-auth.test.ts`) exercising
the helper directly: accepts the exact token, refuses a wrong one, refuses
a missing header, refuses headers shorter/longer than expected without
throwing (the length-mismatch trap), and refuses everything when
`CRON_SECRET` is unset. Updated two existing regex tests
(`privacy-ratelimit.test.ts`, `sheet-events.test.ts`) that asserted the old
literal `CRON_SECRET` string appeared in each route file — it no longer
does, by design, since the check moved into the shared helper.

## CRITICAL, found immediately after: the SSE realtime stream never re-checked session revocation

While reviewing `app/api/rt/route.ts` (the live order/payment/complaint
event stream) for the same authorization patterns, found it used bare
`getSession()` — which only verifies the cookie is validly SIGNED, not that
the account behind it can still sign in. Every other protected route in
this codebase re-derives `active`/`sessionEpoch` status from the DATABASE
on every request via `requireStaff`/`requireStudent`, specifically so a
deactivated staff member or a "sign out everywhere" takes effect
immediately, mid-session — this route was the one place that guarantee
didn't hold. A fired staff member, or someone who killed their other
sessions after a lost phone, could keep an already-open SSE connection
alive and continue receiving live order/payment/complaint data for their
campus indefinitely, with no way to revoke it short of the connection
dropping on its own (network change, browser close).

Fixed by switching to `liveSession()` — already exists in `lib/auth.ts`
specifically as "`requireStaff`/`requireStudent`'s revocation check,
wrapped to return null instead of throwing," built for exactly this shape
of caller but never applied here.

Verified with a new behavioral test
(`tests/rt-revocation-behavioral.test.ts`) that calls the real route
handler: connects successfully while a staff account is active (200),
deactivates the account, and confirms the SAME cookie is now refused (401)
— and the same for a `sessionEpoch` bump (the "sign out everywhere"
mechanism). Confirmed genuine by reverting to `getSession()` and
re-running: both cases returned 200 (still connectable) instead of 401,
exactly as predicted. Full suite: 813/813.

## Reviewed 2026-09-05, client-side pass: PayClient/payments.ts clean, OrderClient's Cancel button fixed

Moved to auditing client-side UI after the server-side surface area was
exhausted. `app/c/pay/[id]/_components/PayClient.tsx` and
`lib/actions/payments.ts` (the Razorpay gateway path) were both already
correctly hardened — busy-guards on every button, timing-safe signature
verification, ownership re-checked server-side, and settlement goes through
the already-proven-safe `payCore` (P2002 unique-index backstop). No changes
needed there.

`app/s/orders/[id]/_components/OrderClient.tsx`'s Cancel button was the one
real find: every other mutating action in the file (collect/pay/refund/
compensation) disables itself via a shared `actionBusy` state while its
request is in flight — Cancel never got the same treatment, despite being
the newest addition to that pattern. Low severity in practice: the
server-side race was already closed earlier today (`cancelOrder`'s atomic
status transition), so a double-tap here would surface a confusing
"already cancelled" toast rather than actually corrupting anything — but
it's the same "fix applied to siblings, not to this one" pattern found
repeatedly this session, worth closing for consistency and defense in
depth. Fixed by giving `handleCancel` the same guard/try/finally shape as
every sibling handler. Verified via the existing regex test group ("money-
moving buttons can't be double-tapped"), extended to check `handleCancel`
too. Full suite: 810/810.

## RESOLVED 2026-09-05: the receipt viewer had a silent authorization bypass for orphaned keys

Auditing the upload/view pipeline (`/api/upload/receipt`, `/api/receipt`,
`/api/upload/intake`, `/api/upload/complaint`, `/api/complaint-photo`) for
IDOR found one real gap: `app/api/receipt/route.ts` checked campus
ownership as `const expense = await db.expense.findFirst(...); if
(expense) { assertSameCollege(...) }` — when NO Expense row referenced the
given key (an orphaned upload: the upload step succeeded but the Expense
record was never created, was later deleted, or the key was simply
guessed/typo'd), the `if (expense)` guard was skipped ENTIRELY and the
route proceeded straight to serving/signing the file for ANY authenticated
staff member at ANY campus — no check at all. This file's own header
comment already states receipt keys are "not secret," which is precisely
why the campus check exists; it just had a hole exactly where an orphaned
key fell through.

Fixed to fail closed: no matching Expense row now returns 404 immediately,
never falling through to the storage-signing step. Verified with a new
behavioral test (`tests/receipt-orphan-key-behavioral.test.ts`) that calls
the real route handler directly — confirms a legitimate cross-campus key is
still refused (401, unchanged) and an orphaned key is refused (404, new).
Confirmed genuine by reverting: the orphaned-key request sailed straight
past authorization and made a real signed-URL call to Supabase (502 from
the nonexistent object), proving the bypass was real, not theoretical.

The sibling routes (`/api/complaint-photo`, `/api/upload/*`) were checked
against the same failure mode and don't share it: `/api/complaint-photo`
checks ownership by querying whether the key appears on any of the
requester's own complaint threads (empty result = deny, fails closed by
construction, no "if found" branch to skip). Full suite: 810/810.

## RESOLVED 2026-09-05: loginWithPasscode had no IP-based rate limit at all

Follow-up to the passcode lockout fix earlier the same day: that fix closed
the per-ACCOUNT brute-force bypass, but auditing `requestOtp`'s rate-limit
usage as a comparison point turned up that `loginWithPasscode` never called
`rateLimit()`/`requestIp()` at all — only `requestOtp` did. The per-account
`pwFailedAttempts` lockout stops an attacker hammering ONE phone number,
but does nothing against an attacker spreading guesses across MANY
different numbers (a few tries per account, never enough to trip any
single account's 5-attempt lock) — still a live brute-force path against a
passcode as short as 4 characters (`MIN_PASSCODE`).

Fixed with the same per-IP cap shape `requestOtp` already has
(`PASSCODE_MAX_PER_IP_HOUR = 20`, via the existing `rateLimit()` helper —
already atomic/race-safe per its own history in this file's audit log).
Verified with a new behavioral test
(`tests/passcode-ip-ratelimit-behavioral.test.ts`) that creates 25 distinct
student accounts and fires one wrong guess against each from the same IP —
confirms the first 20 go through to a real "incorrect passcode" response
and the last 5 are refused by the IP cap. Confirmed genuine by removing
the new check and re-running: 0 of 25 were capped without it, versus 5 of
25 with it. Full suite: 808/808.

## CRITICAL, found immediately after the above: activateSubscription had NO lock at all

While auditing every subscription writer against the "does this lock a row
that might not exist yet" criterion, `activateSubscription` turned out to
have a different, simpler problem: it had no lock whatsoever — not a
mis-targeted one, none. `stu.subscription` was checked outside the
transaction (fine, since a pending Subscription row is a real precondition
here and IS guaranteed to exist first), but the transaction itself just
updated the row and created a Payment with no re-check and no lock at all.
Two concurrent activation clicks (a double-tap, or two Managers) for the
same pending request would both pass the outer check and both reach the
transaction — both update the row (harmless) AND both create a Payment,
charging the student twice for one plan activation.

Fixed with a plain row lock (safe here, unlike assignSubscription/
sellCyclePack, because the Subscription row is guaranteed to already exist
before this transaction starts) plus a fresh re-check that refuses if
`active` is already true. Verified with a third case added to the same
behavioral test file: reverted the lock and reran — confirmed genuine,
both concurrent calls returned `ok: true` and two Payment rows were
created. Full suite: 807/807.

## CRITICAL, found by systematic re-check 2026-09-05: assignSubscription and sellCyclePack could double-charge a student's FIRST plan/pack

Immediately after finding and fixing the identical bug in issueBag (below),
this session grepped EVERY `FOR UPDATE` lock in `lib/` for the same flaw —
a `SELECT ... FOR UPDATE` on a WHERE clause that could legitimately match
zero rows — rather than assuming issueBag was the only instance. It wasn't.

Both `assignSubscription` and `sellCyclePack` in `lib/actions/subscription.ts`
locked with `SELECT id FROM "Subscription" WHERE "studentId" = X FOR
UPDATE` before writing a student's Subscription row. For a student's
FIRST-EVER plan or cycle pack, there is no Subscription row yet — the WHERE
clause matches zero rows, and the lock holds nothing. Worse, both
functions' own comments described exactly this scenario while getting the
conclusion backwards: `assignSubscription`'s comment said "two concurrent
assigns for a student with no plan yet would both pass it" (correctly
describing the race) right above a lock that couldn't stop it;
`sellCyclePack`'s comment claimed "a row that doesn't exist yet... has
nothing to lock — fine, since there's nothing to race against either" —
which is simply wrong. Two concurrent first-ever purchases both read "no
existing subscription," both compute a fresh one-purchase `buckets` array,
and BOTH STILL CHARGE THE STUDENT (a Payment row for assignSubscription, a
cash/credit charge for sellCyclePack) regardless of which one's upsert
becomes the create vs. the update — and the upsert's update branch
overwrites the other's buckets entirely, so one purchase's cycles are
silently discarded while the student is billed for both. This is a live,
real double-charge/lost-cycles bug in core plan-purchasing money paths.

Fixed both with a Postgres advisory lock keyed on `studentId` (same
technique as the `issueBag`, slot-booking, and payslip fixes) — works
whether or not the Subscription row exists yet. Verified with a new
behavioral test (`tests/subscription-first-time-race-behavioral.test.ts`):
confirmed genuine by reverting both locks back to the row-lock version and
re-running — `sellCyclePack`'s test failed exactly as predicted (5 cycles
landed instead of 5+7=12, one purchase's cycles silently discarded).
`assignSubscription`'s test happened to still pass on that one revert run
(same intermittent-reproduction pattern as other short-critical-section
races this session), but the code-level reasoning is identical and the fix
is the same pattern already proven necessary by `sellCyclePack`'s
confirmed failure and `issueBag`'s confirmed failure. Full suite: 806/806.

**This is the same root-cause bug, now confirmed in three independent
places** (issueBag, assignSubscription, sellCyclePack) — a plain row lock
cannot protect a resource that doesn't exist yet; only an advisory lock
(or locking a DIFFERENT row that's guaranteed to already exist, like the
Student row) can. Every other `FOR UPDATE` lock in the codebase was
checked against this exact criterion (does the locked row's existence
depend on the very write being raced?) as part of this same pass:
`auth.ts`'s Student lock (locks the caller's own already-existing row —
safe), `orders.ts`'s Order/Subscription locks in acceptOrder/walkInOrder/
refundOrder/restoreCycleFor (all lock a row already confirmed to exist by
a preceding null-check on the same object — safe),
`subscription.ts`'s `adjustCycleUsage`/`upgradeSubscription` locks (both
require an existing active subscription as a precondition — safe). None of
the others share this flaw.

## CORRECTION 2026-09-05: issueBag's lock had a SECOND, deeper bug the first fix missed

The earlier entry in this file ("issueBag's row lock was never schema-
qualified") turned out to be only half the story, and the caveat in it
undersold a real problem rather than correctly identifying it. In a full
`npm test` run — hours after that fix shipped — `tests/bag-race-
behavioral.test.ts` FAILED for real: two concurrent `issueBag` calls for
the same (brand-new) student both succeeded, leaving two active bags. Not
a flaky infra hiccup — a genuine, reproducible defect in the fixed code.

Root cause: `SELECT ... FOR UPDATE` only locks the rows a WHERE clause
actually MATCHES. The lock was `WHERE "studentId" = X AND status =
'active'` — for a student's FIRST-EVER bag, there is no existing row with
`status = 'active'` yet, so the query matches zero rows, and locking zero
rows locks nothing. The schema-qualification fix was real and necessary,
but it was fixing the WRONG half of the bug — even correctly qualified,
locking a row that doesn't exist yet provides no serialization at all. Two
counters issuing a FIRST bag to the same student at the same instant had
(and, before this correction, still had) nothing stopping them.

Fixed for real with a Postgres advisory lock keyed on `studentId`
(`pg_advisory_xact_lock(hashtext('bag-issue|' + studentId))`) — same
technique as the slot-booking and payslip fixes, and for the same
underlying reason: none of these three have a physical row guaranteed to
exist for a plain row lock to attach to (a fresh slot, a fresh payslip
month, a fresh student's first bag). Re-ran the behavioral test 3
consecutive times with the advisory-lock fix and got 3 clean passes, versus
a confirmed real failure with the row-lock version.

**Lesson, the one that actually matters here**: "reverting the fix and
re-running the test still passed" is NOT the same evidence as "the fix is
correct" — it only proves the test didn't catch a problem on that
occasion. The earlier playbook entry drew the wrong conclusion from a
true observation (the revert-test passed) because it didn't consider that
the ORIGINAL bug being tested for might have a different root cause than
the one just fixed. When a caveated "couldn't reliably reproduce" test
later fails for real, on the FIXED code, in an unrelated full-suite run —
that is a five-alarm signal to stop and re-derive the bug from scratch,
not to shrug it off as the same known flakiness. This is exactly what
happened here, and it very nearly got missed a second time.

## RESOLVED 2026-09-05: createPayslip's double-pay race was live and unprotected in production

Re-reading the existing "Payslip duplicates" note in this file (the DB-level
`@@unique([staffId, month])` constraint was verified safe against
production data but never successfully applied — `prisma db push` refuses
any new unique constraint on a non-empty table, and `--accept-data-loss`
correctly stays off-limits for a session to add unilaterally) surfaced its
real consequence: `createPayslip`'s comment claimed "@@unique([staffId,
month]) is the actual guard," but that constraint DOESN'T EXIST in
production. The `P2002` catch around it had nothing to ever actually catch.
Two concurrent payslip submissions for the same staff+month — a
double-tap, or a retried request — could both silently succeed, posting two
Payslip rows and, if `postExpense` was set, two "Salaries" Expense entries,
genuinely double-paying someone. This was a live, real, currently-open gap
in production money handling, not a hypothetical.

Fixed at the APPLICATION level, no schema migration required: a Postgres
advisory lock (`pg_advisory_xact_lock(hashtext('payslip|staffId|month'))`,
same technique as the slot-booking overbooking fix) taken inside the
transaction, followed by an explicit `tx.payslip.findFirst` duplicate check
before creating the new row. This closes the race regardless of whether the
DB constraint is ever successfully applied, and doesn't preclude adding it
later — the two are complementary, not alternatives.

Verified with a new behavioral test
(`tests/payslip-race-behavioral.test.ts`) that explicitly confirms its own
test schema has NO unique index on `(staffId, month)` (so a pass can't be
credited to a DB backstop by accident), then fires two concurrent
`createPayslip` calls for the same staff+month and confirms exactly one
succeeds. Caveat, checked rather than assumed: reverting just the
advisory-lock line and re-running still passed — the THIRD race this
session that doesn't reliably force itself open against this particular
remote test DB's latency (see the bag-lock and phone-race entries above).
The fix is still correct; full suite: 803/803.

**Lesson**: a comment describing a safety mechanism ("X is the actual
guard") needs to be checked against what's REALLY in the database, not
trusted at face value — this file's own earlier entry had already
documented that the constraint wasn't applied, but the comment in the
actual guard code hadn't been updated to reflect that, so the gap sat
un-remediated even though the information needed to catch it was already
written down one file over.

## RESOLVED 2026-09-05: updateStudentPhone had the same unhandled-P2002 gap registerStudent was already fixed for

Minor but real: `registerStudent` already catches `P2002` on the phone
unique-constraint race (documented in its own comment), but
`updateStudentPhone` — same shape, same table, same unique column — never
got the same treatment. Two concurrent phone-change requests landing on the
same new number would both pass the pre-check `existing` lookup, and the
second write would throw an unhandled Prisma error (a raw 500) instead of
the friendly "This number is already registered to another student"
message the sequential case gives. Lower severity than the other fixes
this session — the DB constraint still prevents any actual duplicate phone,
this only affects how the LOSING request's error looks — but it's the same
gap-not-inherited-by-a-sibling-function pattern found repeatedly this
session (issueBag's lock, cancelOrder vs collectOrder). Fixed by wrapping
the write in the same try/catch pattern.

Caveat, checked rather than assumed: the new behavioral test
(`tests/update-phone-race-behavioral.test.ts`) still PASSED with the fix
temporarily removed — same finding as `tests/bag-race-behavioral.test.ts`
earlier this session. This particular critical section (one `findUnique`,
then the write) is too short for this remote test DB's connection/latency
characteristics to reliably force two `Promise.all`-fired calls into an
actual race. The fix is still correct; the test documents intended
behavior rather than proving exploitability under these exact conditions.

## RESOLVED 2026-09-05: drop-off slots could be overbooked past capacity

Deep-audit pass on `lib/slot-capacity.ts` found `assertSlotBookable` was a
bare `db.order.count` with NO lock, called from `placeOrder`
(`lib/actions/orders.ts`) as a separate round trip well before `placeOrder`'s
own `db.order.create` — completely unserialized despite the function's own
comment claiming "so two students can't take the last seat at once." N
students booking a slot with exactly one seat left could all read the same
"before" count, all pass the capacity check, and all create a draft order
for it, silently exceeding the capacity the whole feature exists to enforce
(spreading the counter queue across drop-off windows).

Unlike every other race fixed this session, there is no physical row to
`SELECT ... FOR UPDATE` here: a `SlotWindow` row is a recurring WEEKLY
TEMPLATE (weekday + startMin + endMin), not a row for one actual
date+time instance — "this college's 9am Tuesday slot" only exists as a
computed value (`buildSlots`), never as a row in the database. Fixed with a
Postgres advisory lock instead — `pg_advisory_xact_lock(hashtext(key))`
keyed on `collegeId|startAtISO` — taken inside the SAME transaction that
then creates the order, so the lock only ever protects a caller who commits
the order in that same transaction (`assertSlotBookable`'s signature now
requires a `tx` for exactly this reason: calling it outside a transaction
that also does the insert doesn't close the race). `placeOrder` was
restructured to wrap the whole slot-check-and-create in one
`db.$transaction`. Advisory locks auto-release at transaction end (commit
or rollback), so there's no separate unlock step and no leak on error.

Verified with a new behavioral test
(`tests/slot-capacity-race-behavioral.test.ts`) that creates a real
capacity-1 `SlotWindow`, fires two concurrent `placeOrder` calls from two
different students for that exact slot, and confirms exactly one succeeds.
Confirmed genuine — not a false-positive test — by temporarily removing
just the advisory-lock line and re-running: both bookings succeeded,
overbooking the capacity-1 slot exactly as predicted. Postgres-only fix (a
sqlite dev fallback has no advisory locks), so the test `describe.skipIf`s
itself when not running against Postgres. Full suite: 800/800 (Postgres).

Slot booking had **zero test coverage of any kind** before this — not even
a source-regex check — worth noting since it means this bug had been live,
unnoticed, since the slot feature shipped.

## Reviewed 2026-09-05, no new issues found (so a future pass doesn't redo this)

Deep-audit pass specifically checked these for the same bug classes fixed
elsewhere this session (missing signature/ownership checks, TOCTOU races,
missing idempotency) and found them already correctly hardened:
- `app/api/razorpay/webhook/route.ts` — timing-safe signature check, re-reads
  fresh inside the transaction, P2002 unique-index backstop on `gatewayRef`
  answers 200 on a genuine duplicate delivery (so Razorpay stops retrying).
- `app/api/whatsapp/webhook/route.ts` — timing-safe signature check (both
  GET handshake and POST delivery), atomic `updateMany({ where: { status:
  "pending" } })` so a Meta retry can't double-resolve a `WaVerify` row.
- `lib/actions/wa-login.ts` (`checkWhatsAppLogin`) — claim cookie compared
  via hash + `timingSafeEqual`, atomic `updateMany({ where: { status:
  "verified" } })` claim so two simultaneous polls can't both mint a session.
- `lib/actions/complaints.ts` — ownership checks present on every path,
  `grantFreeReservice` already atomically claims the complaint before
  linking a redo order (documented tradeoff: the LOSER of that race still
  creates a real redo order, just an unlinked one, visible in the order
  queue rather than a doubly-lost complaint link — accepted, not a bug).
- `lib/offline-queue.ts` / `components/offline.tsx` — `enqueueIntake`
  generates an `idemKey` internally even when the caller omits one (the
  offline no-network path in `CustomerClient.tsx` relies on exactly this),
  so the server-side dedup in `walkInOrder` always has something to key on
  even for a queued intake that never got an explicit key from the caller.

## RESOLVED 2026-09-05: passcode lockout could be bypassed by concurrent guesses

Deep-audit pass on `lib/actions/auth.ts` (auth/OTP flows, not yet checked
this session) found a real brute-force bypass in `loginWithPasscode`:
`pwFailedAttempts` — the ONLY defense on passcode sign-in, since unlike
`requestOtp` there is no `rateLimit()` call anywhere on this path, and a
passcode can be as short as 4 characters (`MIN_PASSCODE`, a 4-digit numeric
PIN having only 10,000 combinations) — was read via a plain `findUnique`
(no lock) and written back with a plain `update`. N concurrent wrong
guesses all read the SAME base count and all write the SAME "count + 1" —
the counter never actually accumulates past a single increment no matter
how many requests land at once. An attacker sending guesses in parallel
batches instead of one at a time could bypass the 5-attempt lockout
entirely and brute-force a student's passcode with effectively no rate
limit.

Fixed with the same lock-and-re-read pattern used for every money-moving
transaction this session: lock the Student row, re-read `pwFailedAttempts`
fresh, THEN compute and write the next count — so concurrent guesses
serialize through the lock and the counter actually reaches
`MAX_PW_ATTEMPTS` regardless of how many requests arrive at once. Also
needed `{ maxWait: 15_000, timeout: 15_000 }` on the transaction (Prisma's
2s/5s defaults were too tight for a burst of guesses queuing on one row,
same tuning `acceptOrder`/`walkInOrder` already needed earlier this
session).

Verified two ways: (1) a new behavioral test
(`tests/passcode-lockout-race-behavioral.test.ts`) firing exactly
`MAX_PW_ATTEMPTS` concurrent wrong guesses and confirming the account
actually locks (not fewer concurrent guesses, which correctly does NOT
lock); (2) checked rather than assumed — reverted the fix and reran, which
failed exactly as predicted: `pwFailedAttempts` stuck at 1 regardless of
whether 5 or 4 concurrent guesses were sent, proving the counter really
was silently not accumulating under concurrency, not a false-positive test.

**Lesson, generalizes**: any per-account "attempts" or "failed tries"
counter that gates a security control (lockout, rate limit) needs the SAME
lock-and-re-read discipline as a money balance — a lost-update on an
attempt counter isn't just a UX inconsistency, it's a way to defeat the
control entirely via parallelization. Check the OTP `attempts` counter in
`verifyOtp` too: it currently writes via `{ increment: 1 }` (safe from the
NULL-poisoning bug since `Otp.attempts` is a non-nullable `Int
@default(0)`), and Postgres's own atomic `SET x = x + 1` for `increment`
DOES serialize correctly on concurrent writers to the same row even without
an explicit app-level lock — so that one is fine. The passcode bug above
was different specifically because it computed the next value in
application code (`stu.pwFailedAttempts + 1`) from a stale read instead of
using `{ increment: 1 }` or a locked re-read.

## RESOLVED 2026-09-05: cancelOrder could double-restore plan cycles under concurrency

Deep-audit pass comparing every order-lifecycle transition against
`collectOrder`'s own documented atomic-update pattern found one that never
got it: `cancelOrder` checked `ord.status` for "cancelled"/"collected"
BEFORE its transaction started, then wrote `tx.order.update({ where: { id },
data: { status: "cancelled", ... } })` with no status guard at all —
unconditional, unlike `collectOrder`'s `updateMany({ where: { id, status:
"ready" }, ... })` + affected-count check.

Two concurrent cancels on the same order (a double-tap, or a retried
offline action) both pass the pre-check, both reach the transaction, and
both call `restoreCycleFor`. The first commits its cycle restore normally.
The second — which only acquires the Subscription row lock after the first
releases it — then reads the ALREADY-restored fresh balance and restores
the exact same cycles into it a SECOND time: the student gets double-
credited cycles for cancelling one order once. This is real money/cycle
leakage, the same class of bug as everything else fixed this session, just
inverted (double-credit instead of double-charge or lost-update).

Fixed the same way `collectOrder` already does it: `updateMany({ where: {
id, status: { notIn: ["cancelled", "collected"] } }, ... })`, check
`.count === 0` and refuse before ever calling `restoreCycleFor` — so only
the transaction that actually wins the status transition gets to restore
cycles. (`updateMany` doesn't support the nested `timeline: { create: ... }`
write `tx.order.update` used, so the `OrderEvent` row is now created as its
own `tx.orderEvent.create` call, same pattern `collectOrder` already uses.)

Verified two ways: (1) a new behavioral test
(`tests/cycle-consume-race-behavioral.test.ts`'s cancelOrder case) that
actually burns 4 real cycles via `walkInOrder`, fires two concurrent
`cancelOrder` calls on that exact order, and confirms exactly one succeeds
and exactly 4 cycles come back, not 8; (2) checked rather than assumed —
reverted the fix and reran the same test, which failed exactly as
predicted (both calls returned `ok: true`), confirming this wasn't a
false-positive test. Full suite: 797/797.

## CRITICAL, found and fixed 2026-09-05: the Audit log page leaked every campus to every Admin

Deep-audit pass checking for other instances of the Sep-5 "server component
queries the DB directly, no campus check" blind spot (the one that already
produced the customer/order detail page CRITICAL earlier today) found one
more, in `app/s/audit/page.tsx`: `db.auditLog.findMany({ orderBy: { at:
"desc" } })` with **no filter at all**, shown to any staff `role >= 3`
(Admin+), not just Owner. `AuditLog` has no `collegeId` column — it only
ever recorded a raw actor id (`by`) — so there was structurally no way to
scope it, and nobody had. A campus-scoped Admin at one college could open
`/s/audit` and read the complete refund/cancellation/cash-compensation/
admin-action history of every OTHER college too. `app/s/reports/page.tsx`
links to this page for any `staff.role >= 3`, so this wasn't a dead
unlinked route — it's reachable from the normal Reports screen.

**The real fix** (add `AuditLog.collegeId`, thread it through the `audit()`
helper and every one of its dozens of call sites across
`lib/actions/*.ts`, backfill existing rows) is too large to land safely in
one sitting — same caution as the Payslip unique-constraint item elsewhere
in this file: don't rush a schema change under time pressure.

**Interim fix actually shipped**: filter `AuditLog` rows by the ACTING
STAFF MEMBER's own `collegeId` (looked up via the same `staffRows` list the
page already fetched to resolve actor names) — the same signal
`assertSameCollege` uses everywhere else to decide who can act on what. A
`"sheet"` row (Google Sheet config edits, not tied to any staff id) can't be
attributed to a campus at all, so it's simply hidden from campus-scoped
Admins rather than guessed at or leaked to everyone. Owner (`collegeId`
null) is unaffected — still sees every campus, unfiltered, by design.

This is a real narrowing of what non-Owner Admins can see (they now see
fewer rows than before, on purpose) — flag it to the owner as a behavior
change, not just a bug fix, in case any Admin workflow depended on
cross-campus audit visibility that was never supposed to exist.

Verified with `tests/audit-log-campus-isolation.test.ts` (source-check —
page.tsx components have no rendering harness in this suite, same
limitation as every other staff page.tsx test here). **Genuinely
unverified**: whether an Admin's OWN actions on students transferred from
another campus, or edge cases around staff who changed colleges, could
still leak a stray row — the interim fix is staff-identity-based, not
event-identity-based, and is a stopgap until the real `collegeId` column
exists.

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

## RESOLVED 2026-09-11 (pass 11): WaVerify registration hijacking on shared computers

Audit pass 11 found a real registration hijacking vulnerability: on a
shared/public computer, an attacker could hijack a BVRIT WhatsApp
registration after the legitimate user had verified their phone but before
they completed the claim.

**The scenario:** User A starts registration with name "Alice", gets a claim
cookie and code "ABC123". User A sends "ABC123" to WhatsApp to verify the
phone `+91 9876543210`. Webhook marks the WaVerify row verified. User A
closes the browser without completing the claim. The httpOnly cookie remains
(TTL 5 minutes). User B on the same computer calls `checkWhatsAppRegister`
with the same code, and the cookie check passes. The account is created
with name "Bob" (attacker-controlled) and phone `+91 9876543210` (verified,
but now owned by the attacker). User A cannot register with their own number
afterward.

**Root cause:** `checkWhatsAppRegister()` accepted a `studentName` parameter
at claim time, inconsistent with how `collegeId` is deliberately locked
server-side when the attempt begins.

**Fix:** `studentName` is now stored in `WaVerify.studentName` when
`startWhatsAppRegister()` creates the attempt. `checkWhatsAppRegister()`
no longer accepts a name parameter; it uses the stored value. The same
pattern already applied to `collegeId`. Both are fixed at attempt-start,
never re-trusted from a claim-time parameter.

Updated: `lib/actions/wa-register.ts` (function signature + usage),
`app/join/bvrit/_components/RegisterForm.tsx` (caller removed the parameter),
test suite updated. Added behavioral test
(`tests/wa-register-name-behavioral.test.ts`) confirming the account is
created under the original name, not a name an attacker might pass at claim
time. Commit dce7695.

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

## RESOLVED 2026-09-11: accept-order / free-redo / advance-status busy-guards, round 6 clean sweep

Rounds 4-5 of the overnight UI-wiring audit found three more buttons with the
same "missing busy-state guard" gap that had already been fixed on every
other mutating button (collect/pay/refund/compensation/cancel/payslip): the
staff order-detail page's "Accept order" (commit 3a26ff9), "Free re-do"
(ec55d8f), and "Start processing / Mark ready / Verify & mark collected"
(d58f7ad) buttons could all be double-tapped to fire two concurrent server
calls. Fixed with the established pattern (busy state + re-entry guard +
try/finally + disabled + "...ing" label), each verified independently (diff
read personally, tsc --noEmit, grep for stale source-slice tests, full
829/829 suite, build, deploy, live console check) before shipping.

Round 6 swept subscriptions, Sheets-sync UI, photo uploads, express-fee
calc, broadcast messaging, and swallowed-error catches - all genuinely
clean. One false alarm worth recording: the agent's report claimed it had
just fixed a "40%-of-subtotal" express-fee display bug in
CustomerClient.tsx, but git log/git status showed no new commit and a
clean tree - the fix was already in the code from a prior session (there's
even an inline comment documenting it: "Bug fixed here..."). The agent
mistook pre-existing code it read for something it had just changed. Lesson
reinforced: an agent's self-report of "what I fixed" must be checked against
git log/git diff, not taken at face value, even when the report sounds
specific and confident - same failure mode as earlier miscounted test
claims, just applied to commit claims instead. Severity of genuine findings
has now dropped to zero for a full round, suggesting the UI-wiring gap class
is close to exhausted.

## AUDIT 2026-10-21: complaints/notifications scope continuation, no new bugs

Resumed the complaints+notifications audit after a prior instance's host
restart. Confirmed its in-flight work was intact and left alone:
`grantFreeReservice` (`lib/actions/complaints.ts`) and `redoOrder`
(`lib/actions/orders.ts`) on `requireStaffPerm("refunds")`,
`broadcastNotice`'s advisory-lock dedup guard (`lib/actions/students.ts`),
and `lib/push.ts` logging send failures to ErrorLog. Also found, already
present and verified by that same batch (not redone here): a real
`refundOrder` perm-check bug (was still bare `requireStaff(1)` despite its
own comment claiming otherwise — a file-grep test was passing by accident)
and a pay-before-accept-order race across `payInner`/the Razorpay webhook
(`lib/actions/orders.ts`, `app/api/razorpay/webhook/route.ts`) — both now
covered by `tests/free-redo-perm-behavioral.test.ts` and
`tests/pay-before-accept-race-behavioral.test.ts`.

Checked the five items in this round's scope; all were already correct,
so no new test/fix was needed:

1. **redoOrder business logic** — re-verified against `scenarios.test.ts`:
   a free redo on a cycle order does not re-consume a cycle or double-charge
   (it creates a zero-total sibling order; the original's cycle consumption,
   if any, isn't touched).
2. **Photo-evidence enforcement** — `MIN_DAMAGE_PHOTOS`/`cleanPhotos`
   (`lib/complaint-rules.ts`) is enforced server-side in both
   `submitComplaint` and `reportOrderDamage` (`lib/actions/complaints.ts`
   lines ~29, ~100), not just client-side — a direct server-action call
   with 0-2 photos is rejected.
3. **Concurrent complaint resolution / double-compensation** — already
   race-safe three ways: `grantFreeReservice` claims the complaint
   (`redoOrderId: null → "claiming"`) via `updateMany` before calling
   `redoOrder()`, with the claim released on any failure including a throw;
   `resolveComplaint` claims via `updateMany({ status: "open" → "resolved" })`
   so only one concurrent resolve lands; `submitCompensation`
   (`lib/actions/credits.ts`) has both an in-transaction duplicate check AND
   a real DB unique index (`compensation_dupe_uniq`, see `ensure-guards.mjs`)
   as the actual race-proof backstop, with P2002 handled as a friendly error.
4. **WhatsApp failure visibility** — already fixed 2026-10-01 per
   `lib/notify.ts`'s own comment; `waPost`'s catch blocks log to console and
   ErrorLog the same way `lib/push.ts` was just fixed to for web push.
5. **In-app notification mark-as-read** — no IDOR possible: both the unread
   count (`app/c/layout.tsx`) and the mark-all-read update
   (`app/c/notifications/page.tsx`) are scoped to `studentId: student.id`
   from the session via `requireStudent()`, never an id taken from input.
   The mark-read is an idempotent `updateMany({ read: false → true })` with
   no side effect attached, so two tabs racing just both no-op after the
   first — nothing to double-process.

`npm test`: 1215/1215 passing after this round (no new tests added — no new
bugs found in this scope).

## 2026-10-21 (continued): admin/reports/registration audit, round 2

Continuing the same pass whose refundOrder/redoOrder permission-gate fix is
already documented above. Systematically checked audit-log coverage across
lib/actions/*.ts (admin.ts, privacy.ts erasure, bags.ts, credits.ts,
subscription.ts, cash.ts, ops.ts, cancelOrder) — every money-moving or
access-control action already calls `audit()`; no new gap found there.
Confirmed `app/s/admin`'s rate-change actions (`saveRates`,
`saveCollegeRates`, `saveCollegeExpressRates`) are gated server-side with
`requireStaff(3)` (Admin+), not just hidden in the UI, and that
`acceptOrder` snapshots `items`/`subtotal`/`gst`/`total`/`gstPctSnapshot`
onto the Order row at acceptance — a later rate change correctly never
retroactively reprices an already-accepted order, since payment/report code
always reads the stored snapshot, never live config.

**Real bug found: `computeReport`'s `ordersIn` counted drafts and
cancellations as "received".** `lib/report.ts`'s order query filtered only
by `createdAt`, with no status filter — so an abandoned app booking that
staff never accepted at the counter, and an order cancelled before any wash
happened, both inflated the Reports screen's "Orders received" tile. The
money-side figures in the same report (`payments`, `invoices`) never had
this problem — a refund/cancellation always has an offsetting reversal
there — but `ordersIn` (and `avgTurnaround`'s implicit context) had no such
correction. Fixed by adding `status: { notIn: ["draft", "cancelled"] }` to
that query. Behavioral test:
`tests/report-ordersin-excludes-draft-cancelled-behavioral.test.ts` (real
Postgres, isolated schema) creates one received, one draft, and one
cancelled order in the same window and asserts `ordersIn === 1`; confirmed
it fails without the fix and passes with it (mutation-tested).

Registration edge cases checked and found already sound: two phones
registering under the identical name (name is not unique, no conflict);
phone reuse after a prior student's erasure (anonymisation overwrites the
real phone with `deleted-{id}`, correctly freeing the original number in
the unique index for reuse); `registerStudent`'s id/bag-code collision
retry loop already disambiguates a genuine phone race from a transient
bag-code collision (2026-10-20 fix, see comment in admin.ts) rather than
leaving orphaned partial state — `activatePlan`'s subscription+bag mint is
one atomic transaction (2026-10-20 fix), so a failed plan step never leaves
a student with a paid subscription and no bag, or vice versa.

`npm test`: 1216/1216 passing after this round (one new test added for the
`ordersIn` fix).

## RESOLVED 2026-10-21: Razorpay gateway signature not tied to a specific order

Payments/webhooks audit (continuing the pass that fixed the draft-order
payment gap in payInner/the webhook route — see that entry above for this
same date). Found a real price-bypass bug in
`confirmGatewayPayment`/`createGatewayOrder` (lib/actions/payments.ts),
separate from the draft-order issue.

**The bug:** `confirmGatewayPayment` verified that `rzp.signature` is a
genuine HMAC(rzpOrderId|paymentId) signed by Razorpay — proof that *some*
payment was captured — but never checked that the Razorpay order it refers
to was the one `createGatewayOrder` actually created for the FabricFold
order being paid. Nothing in the schema recorded which Razorpay order id
belonged to which internal `Order`. A student could run
`createGatewayOrder`/checkout on a cheap order of their own, get Razorpay's
real signature for that genuine small payment, then call
`confirmGatewayPayment` again passing a different, expensive order id
(still their own — `payOrder`'s ownership check only requires
`studentId === stu.id`, which both orders satisfy) together with the same
real `rzpOrderId`/`paymentId`/`signature` triple. The signature check still
passed — it only proves internal consistency of the triple, not which order
it was captured against — so the expensive order was marked fully paid for
the price of the cheap one.

**Fix:** added `Order.gatewayOrderId` (prisma/schema.prisma).
`createGatewayOrder` now stores the Razorpay order id it just created on
the order row; `confirmGatewayPayment` refuses unless the client-supplied
`rzp.orderId` matches that stored value, before even checking the HMAC.
Behavioral test `tests/gateway-crossorder-behavioral.test.ts` reproduces the
cross-order replay against a live Postgres schema, fails pre-fix, passes
post-fix; mutation-tested (reverted the check, confirmed the test fails
again, restored it).

Also re-confirmed, no changes needed: the webhook's signature verification
(constant-time, length-checked first) and its replay protection (the unique
index on `Payment.gatewayRef`, confirmed by `tests/gateway.test.ts`'s own
concurrent-delivery test) are both solid; malformed payloads (missing
`payment.entity`, missing `notes.ff_order_id`) short-circuit safely.
Wallet top-up (`topUpCredits`, lib/actions/ops.ts) and compensation
(`submitCompensation`, lib/actions/credits.ts) already have an advisory
lock + short-window dedupe and a DB-backed unique-index backstop
respectively, both atomic with their `credits: { increment }` write — no
mid-transaction "debited but not credited" gap found. Subscription pricing
(`activatePlan`/`upgradeSubscription`) takes no client-suppliable price
anywhere; every gross/difference is recomputed server-side from the locked,
fresh DB read, matching the pattern already hardened in the 2026-10-20 pass
noted in subscription.ts's own comments.

`refundOrder` is confirmed **ledger-only by design, not an oversight**:
there is no call to Razorpay's refund API anywhere in the codebase for any
`via`, including `"upi"`. Given the counter-driven, cash/UPI-mixed
business (StMary's/BVRIT campus laundry, not a card-on-file e-commerce
store) and that there is no gateway-customer/order mapping stored that
would support an automated refund either, this reads as "staff refund the
student out-of-band (cash in hand, or their own UPI transfer) and the app
just records how," the same manual pattern "cash" refunds already require.
That said, this intent was not written down anywhere before now — nothing
in HANDOFF.md or this playbook said so — so it is worth the owner
explicitly confirming it rather than this being inferred. Double-refund
protection on the same order (row lock + fresh refundAmount re-check,
capped at `order.total`) was already fixed in a prior pass (2026-10-20) and
is intact.

One schema-maintenance note for whoever adds the next column to a "direct"
table (Student/Staff/Plan/Order/Payment/Invoice/CreditNote/Expense/
Complaint — see ensure-guards.mjs's per-college-views block): adding
`Order.gatewayOrderId` made `ensure-guards.mjs`'s `CREATE OR REPLACE VIEW
v_by_college_order` fail with "cannot change name of view column
'collegeName' to 'gatewayOrderId'" — Postgres only allows appending columns
to a view's output list, and `x.*, c.name AS "collegeName"` means any new
column on the base table lands BEFORE collegeName in the view's column
list, not after. This is pre-existing, already-handled-by-design: the
script wraps this whole block in try/catch and only warns, specifically so
a view-definition snag never blocks a deploy. Ran `ensure-guards.mjs`
against every live test schema (ff_test, ff_agg, public/dev) after this
change; the per-college views for Order are stale until someone drops and
recreates them (or ensure-guards.mjs is changed to DROP + CREATE instead of
CREATE OR REPLACE for this table), but nothing else depends on them in the
test suite today.

`npm test`: 1217/1217 passing after this round (one new test added:
`tests/gateway-crossorder-behavioral.test.ts`).

## RESOLVED 2026-10-21: live-tested as a real customer on both campuses — a draft cycle order's own detail page contradicted its own pre-book quote

Owner, same session: "test everything once again ... go deep fixing, live
testing in all angles like user and staff." Signed in live on production
(fabricfold.in) as a real customer on each campus — BVRIT (per-piece
pricing, V1019) and St Mary's (cycle-based pricing, S1746) — placed a real
order on each, checked notifications/wallet/profile, then cleaned both test
orders up via "Delete draft" (confirmed that's a plain `window.confirm()`,
not a dead button — the browser-automation tool just can't click through a
native dialog without overriding it for the test).

**Real bug found: a pre-booked cycle order's own detail page shows a cash
total that flatly contradicts what the booking form just quoted seconds
earlier.** The "New order" form (`OrderNewClient.tsx`) correctly tells a
subscribed student their cycle order is "Estimated total ₹0 / From your
plan" — but `placeOrder` has no way to know yet whether staff will actually
burn a cycle at drop-off (that's decided later in `acceptOrder`), so the
draft row it creates stores the full cash-equivalent total (e.g. ₹200 for a
Wash & Fold cycle) exactly as a walk-in with no plan would owe. A student
who pre-books and then taps straight into their own order sees "Total ₹200"
— directly contradicting the ₹0 they were just told, with no indication
it'll resolve itself once accepted. Confirmed live: placed order #1203 on
St Mary's production, form said ₹0, order detail page said ₹200.

Not a billing bug — `acceptOrder` recomputes the real total fresh and
correctly, so a draft order is never actually charged the shown amount.
Purely a self-contradicting screen, but exactly the class of "silly,
confusing mistake" the owner has been flagging all session.

Fixed in `app/c/orders/[id]/page.tsx`: while an order is still a `draft`,
is cycle-based, and the student has an active subscription, the itemised
rows, subtotal, and total now show "From your plan" (matching the booking
form) instead of the stored cash total, with a line explaining it's
confirmed at drop-off. Resolves to the real number automatically once
`acceptOrder` runs and the order leaves draft status — zero change to any
money-computing code path.

Also found via a live Sentry error the owner forwarded mid-session: a POST
to `https://fabricfold.in/app` threw Next's framework-level "Expected RSC
response, got text/plain" error. `/app` has never been a real route in this
codebase (customer is `/c`, staff is `/s`) — no redirect, no manifest
`start_url`, nothing in git history ever served it. Most likely an old
pinned home-screen shortcut or bookmark from before the `/c`/`/s` split, or
bot/scanner traffic. Added a redirect (`/app` → `/c`) in `next.config.ts` as
a safety net for a fresh visit; this can't retroactively fix an already-
stale client's own cached shell (that resolves on its own next reload), so
if this keeps recurring from the same source it's worth asking the owner
whether anyone has an old homescreen icon pointed there.

`npm test`: 1217/1217 passing (no new tests — pure display-logic fix, no
new money-affecting code path to regression-test; `tsc --noEmit` clean,
`npm run build` succeeds with the same route table).

## RESOLVED 2026-10-21: live staff-side testing found /s/reports crashing blank — a hydration-safety guard that only checked half the codebase

Owner asked to find another way into a staff session after WhatsApp login
couldn't be automated (popup blocked). Captured the deep-link URL
`startWhatsAppLogin` would have opened (intercepted `window.open` before
clicking "Continue with WhatsApp") and had the owner send that exact
WhatsApp message from the real Owner phone — the page's own poll picked it
up and signed in, no code to relay. Then ran a real staff session through
the full order lifecycle live on production: created a walk-in order for
the BVRIT test customer (V1019), Start processing → Mark ready (with the
recount-confirmation step) → Record cash payment → Collect via Order ID —
every status transition, the piece-recount prompt, and the lifetime-pieces
counter (7 → 9) all worked correctly. Order #1204, ₹20, left as a completed
test transaction rather than refunded/cancelled (not worth another real
action over ₹20).

**Real bug found: `/s/reports` rendered completely blank.** Console showed
React error #418 (hydration mismatch) — the same class of bug this
codebase already has a named fix for (`components/time-ago.tsx`, from a
Sep 21 QA pass: a server-rendered "just now" disagreeing with the client's
recomputed "1m ago" a moment later makes React discard the whole
mismatched subtree). `app/s/reports/page.tsx` was calling the raw
`timeAgo()` utility directly in its JSX instead of the `<TimeAgo/>`
component built to prevent exactly this. Grepped for the same mistake
everywhere else and found three more Server Components doing it:
`app/c/orders/[id]/page.tsx`, `app/c/notifications/page.tsx`,
`app/c/help/page.tsx`. Fixed all four to use `<TimeAgo/>`.

**The more important finding: the existing regression test for this exact
bug class never covered any of these four files.**
`tests/time-ago-hydration.test.ts`'s "uses <TimeAgo/> instead" check only
scanned files with an explicit `"use client"` directive at the top — a
plain Server Component (no directive at all) calling `timeAgo()` straight
into server-rendered JSX has the identical failure mode but was invisible
to that regex. Widened the test with a second describe block that checks
the inverse (files WITHOUT `"use client"`), so a server component can't
reintroduce this. Mutation-tested: reverted the `/s/reports` fix alone,
confirmed the new test fails and names exactly that file, restored it,
confirmed it passes again.

Lesson for future "is this covered" checks: a guard test's own scope
(which files it walks, which pattern it matches) is itself something that
can quietly stop covering the thing it was written for — this one was
written for client components specifically because that was the Sep 21
bug, and nobody widened it when the same mistake showed up again in a
Server Component two months later.

`npm test`: 1218/1218 passing (one test file extended, not added — the
existing `time-ago-hydration.test.ts`). `tsc --noEmit` clean, `npm run
build` succeeds with the same route table.

## RESOLVED 2026-10-21: a second, site-wide hydration error — Sentry Replay's text-masking racing React's own hydration check

After the `/s/reports` fix above, the same React error #418 kept appearing
in the console on EVERY page checked — including `/terms`, fully static,
zero app data, no auth. That ruled out anything data- or timeAgo-related;
the previous fix was real and confirmed (Reports now renders full data),
but this was a second, unrelated bug hiding behind the first.

Root cause: Sentry's Session Replay integration (`maskAllText: true` —
replaces visible text with asterisks client-side so no student PII leaves
the device in a replay) was registered inside the same `Sentry.init()`
call that Next's `instrumentation-client.ts` convention deliberately runs
as early as possible, specifically so Sentry can catch errors from the
very first tick. That earliness is exactly what let Replay's own
MutationObserver start rewriting text nodes WHILE React was still mid-way
through comparing the server-rendered HTML to the client's first render —
React sees text it didn't produce, concludes the tree doesn't match, and
discards + rebuilds it (the same `rQ`/hydration frames as the reports bug,
different root cause).

Fixed by splitting the two concerns `instrumentation-client.ts` was
collapsing into one: error capture needs to start immediately (unchanged —
`Sentry.init()` still runs synchronously), but Replay's DOM-touching setup
doesn't, and was only ever grouped with it for convenience. Replay is now
added via `Sentry.addIntegration()` inside a `setTimeout(..., 0)`, which
runs after React's hydration commit instead of racing it.

**CONFIRMED after deploy.** Testing the deployed fix initially appeared to
fail — same error, same stack — until checking the actual chunk filename
being loaded against the server directly (`curl` the live HTML for its
`<script>` tags) showed the test browser was still serving `0nvq0j5fbtrwg.js`
from stale cache/service-worker storage, a chunk that 404s on the real
server; the live HTML's real chunks all had different names entirely. The
page's own `PwaSetup` re-registers `/sw.js` on every mount, so unregistering
the worker and clearing Cache Storage mid-session wasn't enough — only a
brand-new browser tab with no prior visit to the origin gave an honest
read. On that clean tab: zero console errors on `/terms`, `/s/reports`, and
`/s` alike. Diagnosis confirmed, not just inferred.

Root-cause confidence before that confirmation: high but not 100% proven,
since Sentry's own SDK internals are minified in production and the error
itself only reports a minified React code with no component name. Traced
it via direct elimination: the error (a) is `role` and data independent
(reproduces on a fully static page), (b) requires JS/hydration (never
happens on pure server HTML), (c) Sentry's replay integration is a
well-documented source of exactly this interaction in the wider
Next.js/Sentry community, and (d) `window.__SENTRY__` confirmed present on
the affected pages. Recommend
the owner watch Sentry's own error stream for a few days after this
deploys — if `#418` events stop appearing, that confirms the diagnosis; if
they continue, there's a second source still to find.

`npm test`: 1218/1218 (no new test — this is a client-side script timing
fix with no server-testable behavior; verified via `tsc --noEmit` clean and
`npm run build` succeeding, plus live reproduction before/after in the
browser).
