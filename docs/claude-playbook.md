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
