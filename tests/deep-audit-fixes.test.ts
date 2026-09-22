/* Locks in the second round of fixes from a full-app "test everything in all
   angles" audit (Sep 2026), spanning security, races, and reliability across
   server actions, API routes, and one core utility. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("the standing student-wipe endpoint is gone", () => {
  it("app/api/admin/wipe-students no longer exists", () => {
    expect(fs.existsSync(path.resolve(__dirname, "..", "app/api/admin/wipe-students"))).toBe(false);
  });
});

describe("campus-boundary bypasses closed in API routes", () => {
  it("college-statement export checks the requesting staff's own campus", () => {
    const src = read("app/api/export/college-statement/route.ts");
    expect(src).toMatch(/assertSameCollege\(staff, collegeId\)/);
  });
  it("bulk student import checks the requesting staff's own campus", () => {
    const src = read("app/api/import/students/route.ts");
    expect(src).toMatch(/assertSameCollege\(staff, collegeId\)/);
  });
  it("expense receipts are scoped to the expense's own campus, not open to any staff", () => {
    const src = read("app/api/receipt/route.ts");
    expect(src).toMatch(/assertSameCollege\(staff, expense\.collegeId\)/);
  });
  it("the company-wide XLSX export scopes computeReport (and its name lookups) to the caller's campus", () => {
    const src = read("app/api/export/xlsx/route.ts");
    // The scope starts as the caller's OWN campus (a scoped account can never
    // widen it via ?c=); only an owner-level account may pick one.
    expect(src).toMatch(/let scopeId = me\.collegeId;/);
    expect(src).toMatch(/if \(!scopeId && asked\)/);
    expect(src).toMatch(/computeReport\(p, scopeId\)/);
    expect(src).toMatch(/db\.staff\.findMany\(scopeId \? \{ where: \{ collegeId: scopeId \} \} : undefined\)/);
    expect(src).toMatch(/db\.student\.findMany\(scopeId \? \{ where: \{ collegeId: scopeId \} \} : undefined\)/);
  });
  it("the Reports screen itself scopes computeReport too — not just its export", () => {
    // Renamed staff.collegeId -> selectedCollegeId when the Owner per-campus
    // report switcher was added (an Owner can now pick a campus; a scoped
    // staffer's own collegeId still wins either way).
    const src = read("app/s/reports/page.tsx");
    expect(src).toMatch(/computeReport\(period, selectedCollegeId\)/);
  });
  it("computeReport actually filters every underlying query when a collegeId is given", () => {
    const src = read("lib/report.ts");
    expect(src).toMatch(/export async function computeReport\(p: Period, collegeId\?: string \| null\)/);
    expect(src).toMatch(/const withCollege = \(where: Record<string, unknown>\) => \(collegeId \? \{ \.\.\.where, collegeId \} : where\)/);
    // Compensation has no direct collegeId column — must scope through the student relation instead.
    expect(src).toMatch(/collegeId \? \{ student: \{ collegeId \} \} : \{\}/);
  });
});

describe("rate limiting is atomic, not check-then-act", () => {
  const src = read("lib/rate-limit.ts");
  it("uses a single INSERT ... ON CONFLICT, not a separate read then upsert/increment", () => {
    expect(src).toMatch(/INSERT INTO \$\{table\}/);
    expect(src).toMatch(/ON CONFLICT \(key\) DO UPDATE SET/);
    // Schema-qualified via Prisma.raw — raw SQL doesn't pick up ?schema=...
    // the way Prisma's ORM methods do, so a bare "RateLimit" would hit the
    // wrong schema whenever DATABASE_URL isn't the default.
    expect(src).toMatch(/const table = Prisma\.raw\(`\$\{dbSchemaPrefix\}"RateLimit"`\)/);
    // The old three-round-trip shape must be gone.
    expect(src).not.toMatch(/const row = await db\.rateLimit\.findUnique/);
  });
  it("still fails open on a limiter error, same as before", () => {
    expect(src).toMatch(/rateLimit failed open/);
  });
});

describe("flushSheetOutbox claims its batch before appending, holding the lock through the Google call", () => {
  const src = read("lib/sheet-events.ts");
  it("uses SELECT ... FOR UPDATE SKIP LOCKED inside a transaction", () => {
    expect(src).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(src).toMatch(/await db\.\$transaction\(async \(tx\) => \{/);
  });
  it("schema-qualifies the raw table reference — same fix as rate-limit.ts", () => {
    expect(src).toMatch(/const table = Prisma\.raw\(`\$\{dbSchemaPrefix\}"SheetOutbox"`\)/);
  });
  it("the append call and the sent/failed marking both happen with `tx`, inside that same transaction", () => {
    const fn = src.slice(src.indexOf("export async function flushSheetOutbox"));
    const txBody = fn.slice(fn.indexOf("await db.$transaction"), fn.indexOf("}, { timeout:"));
    expect(txBody).toMatch(/await appendSheet\(/);
    expect(txBody).toMatch(/tx\.sheetOutbox\.updateMany/);
  });
});

describe("issueBag can't create two active bags for one student under concurrency", () => {
  const bagsSrc = read("lib/actions/bags.ts");
  const fn = bagsSrc.slice(bagsSrc.indexOf("export async function issueBag"), bagsSrc.indexOf("export async function issueBag") + 5500);
  it("locks and re-checks 'already active' fresh, inside the transaction", () => {
    expect(fn).toMatch(/FOR UPDATE`/);
    expect(fn).toMatch(/const stillActive = await tx\.bag\.findFirst/);
  });
  it("retries automatically on a recycled-code collision, but not on the active-bag business refusal", () => {
    expect(fn).toMatch(/for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
    expect(fn).toMatch(/isCodeCollision = \(e as \{ code\?: string \}\)\.code === "P2002"/);
  });
});

describe("grantFreeReservice can't give away a free re-service twice", () => {
  it("claims the complaint atomically (redoOrderId still null) before recording the redo", () => {
    const src = read("lib/actions/complaints.ts");
    const fn = src.slice(src.indexOf("export async function grantFreeReservice"), src.indexOf("export async function resolveComplaint"));
    expect(fn).toMatch(/db\.complaint\.updateMany\(\{ where: \{ id: complaintId, redoOrderId: null \}/);
    expect(fn).toMatch(/if \(claimed\.count === 0\)/);
  });
});

describe("resolveComplaint can't resolve twice and send duplicate notifications", () => {
  it("claims the complaint atomically (status still open) before recording the resolution", () => {
    const src = read("lib/actions/complaints.ts");
    const fn = src.slice(src.indexOf("export async function resolveComplaint"));
    expect(fn).toMatch(/db\.complaint\.updateMany\({[\s\S]*?where:[^}]*complaintId[^}]*status/);
    expect(fn).toMatch(/if \(claimed\.count === 0\)/);
    expect(fn).toMatch(/Complaint is already resolved/);
  });
});

describe("BVRIT self-registration can actually be retried after a failure", () => {
  it("reverts the WaVerify claim back to 'verified' if account creation throws", () => {
    const src = read("lib/actions/wa-register.ts");
    expect(src).toMatch(/db\.waVerify\.updateMany\(\{ where: \{ id: row\.id, status: "claimed" \}, data: \{ status: "verified" \} \}\)/);
  });
});

describe("registration/staff-add races on a duplicate phone return a friendly error, not an unhandled throw", () => {
  it("registerStudent catches the unique-constraint violation", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function registerStudent"), src.indexOf("export async function updateStudentPhone"));
    expect(fn).toMatch(/if \(\(e as \{ code\?: string \}\)\.code === "P2002"\) return \{ ok: false as const, error: "This number is already registered" \}/);
  });
  it("saveStaff catches it too, on the create path", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function saveStaff"));
    expect(fn).toMatch(/This number is already registered to another staff member/);
  });
});

describe("the Add/Edit staff sheet sends the staffer's REAL campus, not a hardcoded null", () => {
  /* Real bug found live-testing (Sep 2026): the Save button always sent
     `collegeId: null` unconditionally, whether adding a new staffer or
     editing an existing one. That's the right value ONLY for an Owner
     (global by design) — saveStaff's own assertSameCollege(st,
     input.collegeId) check then compares a campus-scoped Admin's own
     (non-null) collegeId against that hardcoded null and throws "That's a
     different campus — not yours to change" on EVERY save. A campus Admin
     could not add or edit a single staff member through this UI at all —
     confirmed live: three failed attempts before the server log named the
     exact line. Fixed: stEdit now carries a real collegeId (defaulted to
     the staffer's own on edit, colleges[0] on add, with a Campus picker
     when an Owner has more than one campus in scope), and the Save button
     only forces null for an Owner-role (4) account. */
  it("Save forces collegeId null only for Owner-role accounts, otherwise sends stEdit.collegeId", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/saveStaff\(\{ \.\.\.stEdit, collegeId: stEdit\.role >= 4 \? null : stEdit\.collegeId \}\)/);
    expect(ui).not.toMatch(/saveStaff\(\{ \.\.\.stEdit, collegeId: null \}\)/);
  });
  it("editing an existing staffer carries their real collegeId into the form, not null", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/setStEdit\(\{ id: x\.id, name: x\.name, phone: x\.phone, role: x\.role, collegeId: x\.collegeId,/);
  });
  it("adding a new staffer defaults to the first campus in scope, not null", () => {
    const ui = read("app/s/admin/_components/AdminClient.tsx");
    expect(ui).toMatch(/setStEdit\(\{ name: "", phone: "", role: 1, collegeId: colleges\[0\]\?\.id \?\? null, perms: \{\} \}\)/);
  });
});

describe("bulkRegisterStudents isolates a bad row instead of aborting the whole import", () => {
  it("wraps the create in try/catch and keeps going", () => {
    const src = read("lib/actions/students.ts");
    const fn = src.slice(src.indexOf("export async function bulkRegisterStudents"));
    expect(fn).toMatch(/try \{\s*\n\s*await db\.student\.create/);
    expect(fn).toMatch(/skipped\.push\(\{ line, reason: \(e as \{ code\?: string \}\)\.code === "P2002" \? "already registered" : "could not be created" \}\)/);
  });
});

describe("topUpCredits respects the campus boundary like every other staff action", () => {
  it("calls assertSameCollege before crediting the wallet", () => {
    const src = read("lib/actions/ops.ts");
    const fn = src.slice(src.indexOf("export async function topUpCredits"));
    expect(fn).toMatch(/assertSameCollege\(st, stu\.collegeId\)/);
  });
});

describe("money-moving buttons can't be double-tapped, and refund/compensation confirm first", () => {
  it("OrderClient: collect/pay/refund/compensation/cancel all share one busy guard", () => {
    // cancel was the odd one out until 2026-09-05 — every other mutating
    // action here already guarded against a double-tap with actionBusy, but
    // handleCancel had no busy tracking and its button had no `disabled` at
    // all. The server-side race was already closed (cancelOrder's own atomic
    // status transition), so this was a UX consistency gap, not a money bug.
    const src = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(src).toMatch(/const \[actionBusy, setActionBusy\] = useState\(false\)/);
    expect((src.match(/setActionBusy\(true\)/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(src).toMatch(/onClick=\{handleRefund\} disabled=\{actionBusy\}/);
    expect(src).toMatch(/onClick=\{handleCompensation\} disabled=\{actionBusy\}/);
    expect(src).toMatch(/onClick=\{handleCancel\} disabled=\{actionBusy\}/);
  });
  it("OrderClient: refund and compensation confirm before firing", () => {
    const src = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(src).toMatch(/if \(!confirm\(`Refund \$\{fmt\(refundInput\.amount\)\}/);
    expect(src).toMatch(/if \(!confirm\(`Issue \$\{fmt\(compInput\.amount\)\} compensation/);
  });
  it("CustomerClient and ComplaintsClient compensation buttons confirm and guard against double-submit", () => {
    for (const f of ["app/s/customers/[id]/_components/CustomerClient.tsx", "app/s/complaints/_components/ComplaintsClient.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/const \[compBusy, setCompBusy\] = useState\(false\)/);
      expect(src, f).toMatch(/if \(!confirm\(`Issue \$\{fmt\(comp\.amount\)\} compensation/);
      // CustomerClient additionally disables on a non-positive amount (fixed
      // 2026-09-11, client-side mirror of the server's own rejection) —
      // match either form, both still guard against double-submit.
      expect(src, f).toMatch(/disabled=\{compBusy(?: \|\| comp\.amount <= 0)?\}/);
    }
  });
  it("HomeClient subscription activation has a busy guard", () => {
    const src = read("app/s/_components/HomeClient.tsx");
    expect(src).toMatch(/const \[activateBusy, setActivateBusy\] = useState\(false\)/);
    expect(src).toMatch(/disabled=\{activateBusy\}/);
  });
});

describe("three more unguarded server-action calls now recover from a thrown error", () => {
  it("ReportsClient's day-close doesn't get stuck busy on failure", () => {
    const src = read("app/s/reports/_components/ReportsClient.tsx");
    const fn = src.slice(src.indexOf("const doClose = async"), src.indexOf("const diff = Math.round"));
    expect(fn).toMatch(/try \{[\s\S]*catch \(e\) \{[\s\S]*finally \{\s*setBusy\(false\);/);
  });
  it("ReportsClient's expense logger catches, not just finally", () => {
    const src = read("app/s/reports/_components/ReportsClient.tsx");
    const start = src.indexOf("const save = async");
    const fn = src.slice(start, start + 1200);
    expect(fn).toMatch(/catch \(e\) \{\s*\n\s*toast\(e instanceof Error \? e\.message : "Failed", true\);/);
  });
  it("HelpClient's complaint submit doesn't get stuck busy on failure", () => {
    const src = read("app/c/help/_components/HelpClient.tsx");
    const fn = src.slice(src.indexOf("const handleSubmitComplaint = async"));
    expect(fn).toMatch(/try \{[\s\S]*catch \(e\) \{[\s\S]*finally \{\s*setLoading\(false\);/);
  });
});

describe("a staff role change forces re-login, same as deactivation does", () => {
  it("saveStaff bumps sessionEpoch when role actually changes", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function saveStaff"), src.indexOf("export async function setStaffActive"));
    expect(fn).toMatch(/const roleChanged = priorRole !== undefined && priorRole !== input\.role/);
    expect(fn).toMatch(/roleChanged \? \{ sessionEpoch: \{ increment: 1 \} \}/);
  });
});

describe("date boundaries are IST, not the server's UTC — the same class as the fixed financialYearTag bug", () => {
  it("parsePeriod anchors every period to IST midnight via an explicit +05:30 offset", () => {
    const src = read("lib/report.ts");
    expect(src).toMatch(/const istDateStr = \(\) => new Date\(Date\.now\(\) \+ 5\.5 \* 3600_000\)\.toISOString\(\)\.slice\(0, 10\)/);
    expect(src).toMatch(/const istBoundary = \(dateStr: string\) => new Date\(`\$\{dateStr\}T00:00:00\+05:30`\)/);
    // no bare local-time "today" left anywhere in the period logic
    expect(src).not.toMatch(/new Date\(new Date\(\)\.toDateString\(\)\)/);
    expect(src).not.toMatch(/new Date\(\)\.getFullYear\(\)/);
  });
  it("the staff home's today-takings boundary is the IST day, not setHours(0,0,0,0) on a UTC server", () => {
    const src = read("app/s/page.tsx");
    expect(src).toMatch(/const startOfDay = new Date\(`\$\{istDate\}T00:00:00\+05:30`\)/);
    expect(src).not.toMatch(/setHours\(0, 0, 0, 0\)/);
  });
  it("ReportsClient's date-picker defaults are computed in IST, not the device's timezone", () => {
    const src = read("app/s/reports/_components/ReportsClient.tsx");
    expect(src).toMatch(/const istNow = new Date\(Date\.now\(\) \+ 5\.5 \* 3600_000\)/);
    expect(src).not.toMatch(/String\(new Date\(\)\.getFullYear\(\)\)/);
  });
});

describe("three more concurrency/state bugs found by a deep hand-traced re-audit of the core money/cycle logic", () => {
  const orders = read("lib/actions/orders.ts");
  const subs = read("lib/actions/subscription.ts");

  it("refundOrder locks the order row and re-checks the refund cap against a fresh read, not the pre-transaction snapshot", () => {
    const fn = orders.slice(orders.indexOf("export async function refundOrder"), orders.indexOf("export async function redoOrder"));
    expect(fn).toMatch(/const table = Prisma\.raw\(`\$\{dbSchemaPrefix\}"Order"`\);/);
    expect(fn).toMatch(/SELECT id FROM \$\{table\} WHERE id = \$\{o\.id\} FOR UPDATE/);
    expect(fn).toMatch(/const fresh = await tx\.order\.findUniqueOrThrow\(\{ where: \{ id: o\.id \}, select: \{ refundAmount: true, total: true \} \}\)/);
    expect(fn).toMatch(/if \(amount > stillRefundable\) \{/);
  });

  it("restoreCycleFor locks the subscription and re-reads it fresh instead of writing back a stale pre-transaction snapshot", () => {
    const fn = orders.slice(orders.indexOf("async function restoreCycleFor"), orders.indexOf("export async function cancelOrder"));
    expect(fn).toMatch(/SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE id = \$\{sub\.id\} FOR UPDATE/);
    expect(fn).toMatch(/const fresh = await tx\.subscription\.findUniqueOrThrow\(\{ where: \{ id: sub\.id \} \}\)/);
  });

  it("walkInOrder creates one CycleUse row per cycle consumed, matching acceptOrder, not one row per order", () => {
    const fn = orders.slice(orders.indexOf("export async function walkInOrder"), orders.indexOf("export async function walkInOrder") + 7000);
    expect(fn).toMatch(/tx\.cycleUse\.createMany\(\{ data: Array\.from\(\{ length: cyclesCount \}, \(\) => \(\{ subscriptionId: stu\.subscription!\.id, orderId: o\.id \}\)\) \}\)/);
  });

  it("acceptOrder and walkInOrder lock the subscription and re-read it fresh before burning a plan cycle (2026-09-05 audit)", () => {
    const acceptFn = orders.slice(orders.indexOf("export async function acceptOrder"), orders.indexOf("export async function walkInOrder"));
    const walkInFn = orders.slice(orders.indexOf("export async function walkInOrder"), orders.indexOf("export async function walkInOrder") + 7000);
    for (const fn of [acceptFn, walkInFn]) {
      expect(fn).toMatch(/SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE id = \$\{preSub\.id\} FOR UPDATE/);
      expect(fn).toMatch(/const sub = await tx\.subscription\.findUniqueOrThrow\(\{ where: \{ id: preSub\.id \} \}\)/);
    }
  });

  it("subscription.ts's row locks that protect an ALWAYS-existing row (adjustCycleUsage, upgradeSubscription, activateSubscription) are schema-qualified", () => {
    // assignSubscription and sellCyclePack were switched to a Postgres
    // advisory lock instead of a row lock, because both protect a student's
    // FIRST subscription/pack — a row that doesn't exist yet, which a
    // SELECT ... FOR UPDATE cannot lock. adjustCycleUsage, upgradeSubscription,
    // and activateSubscription (added 2026-09-05, previously had NO lock at
    // all) all require an existing subscription as a precondition, so a row
    // lock is safe for those three. See docs/claude-playbook.md.
    expect((subs.match(/SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE "studentId" = \$\{studentId\} FOR UPDATE/g) || []).length).toBe(3);
  });
  it("assignSubscription and sellCyclePack use an advisory lock instead, since a first-time student has no row to lock", () => {
    // assignSubscription's own lock moved into lib/plan-activation.ts (Sep 22),
    // shared with registerStudent's now-mandatory plan step — count both files.
    const core = read("lib/plan-activation.ts");
    const total = (subs.match(/SELECT pg_advisory_xact_lock\(hashtext\(\$\{`subscription\|\$\{studentId\}`\}\)\)/g) || []).length
      + (core.match(/SELECT pg_advisory_xact_lock\(hashtext\(\$\{`subscription\|\$\{stu\.id\}`\}\)\)/g) || []).length;
    expect(total).toBe(2);
  });
});

describe("Admin's payslip-target and import-campus dropdowns can't silently point at the wrong selection after a campus switch", () => {
  it("resets slip.staffId to a visible staff member when the campus filter changes", () => {
    const src = read("app/s/admin/_components/AdminClient.tsx");
    expect(src).toMatch(/if \(!visibleStaff\.some\(\(x\) => x\.id === slip\.staffId\)\) \{\s*\n\s*setSlip\(\(s\) => \(\{ \.\.\.s, staffId: visibleStaff\[0\]\?\.id \|\| "" \}\)\);/);
  });
  it("resets impCollege to a visible college when the campus filter changes", () => {
    const src = read("app/s/admin/_components/AdminClient.tsx");
    expect(src).toMatch(/if \(!visibleColleges\.some\(\(c\) => c\.id === impCollege\)\) \{/);
    expect(src).toMatch(/<select className="input" value=\{impCollege\} onChange=\{\(e\) => setImpCollege\(e\.target\.value\)\}>\s*\n\s*\{visibleColleges\.filter/);
  });
});

describe("Owner can narrow the Admin page to one campus at a time, not just see both stacked", () => {
  it("AdminClient derives visible* lists from a campus switch instead of rendering the raw props directly", () => {
    const src = read("app/s/admin/_components/AdminClient.tsx");
    expect(src).toMatch(/const \[campus, setCampus\] = useCampusSwitch\(colleges\);/);
    expect(src).toMatch(/const visibleColleges = campus === "all" \? colleges : colleges\.filter\(\(c\) => c\.id === campus\);/);
    expect(src).toMatch(/const visibleStaff = campus === "all" \? staff : staff\.filter\(\(x\) => x\.collegeId === campus\);/);
    expect(src).toMatch(/<CampusSwitch colleges=\{colleges\} value=\{campus\} onChange=\{setCampus\} \/>/);
    // the three per-college sections (colleges&features, plans, slots) must all read the filtered list
    expect((src.match(/\{visibleColleges\.map\(\(c\) => \(/g) || []).length).toBe(3);
  });
});

describe("Owner can view Reports scoped to a single campus, not only company-wide", () => {
  it("page.tsx threads a selected college through every analytics query, not just computeReport", () => {
    const src = read("app/s/reports/page.tsx");
    expect(src).toMatch(/const selectedCollegeId = staff\.collegeId \?\? \(sp\.c && ownerColleges\.some/);
    expect(src).toMatch(/computeReport\(period, selectedCollegeId\)/);
    expect((src.match(/selectedCollegeId \? \{ collegeId: selectedCollegeId \}/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it("ReportsControls renders a campus switch for an Owner and preserves it across period changes", () => {
    const src = read("app/s/reports/_components/ReportsClient.tsx");
    expect(src).toMatch(/colleges && colleges\.length > 1/);
    expect(src).toMatch(/const navCollege = \(c: string\) => \{/);
  });
});

describe("list-count subtitles track the client-filtered list, not the full server-fetched one", () => {
  it("StudentsClient's TopBar reads filtered.length, rendered outside .pad (not nested/double-padded)", () => {
    const src = read("app/s/students/_components/StudentsClient.tsx");
    expect(src).toMatch(/<TopBar title="Students" sub=\{`\$\{filtered\.length\} total`\} back="\/s" \/>/);
    // TopBar must come before the .pad div opens, as a sibling — not inside it.
    const topBarIdx = src.indexOf('<TopBar title="Students"');
    const padIdx = src.indexOf('<div className="pad">');
    expect(topBarIdx).toBeGreaterThan(-1);
    expect(padIdx).toBeGreaterThan(topBarIdx);
    // The server page must no longer render its own copy (would show the stale count again).
    const page = read("app/s/students/page.tsx");
    expect(page).not.toMatch(/<TopBar/);
  });

  it("OrdersClient's TopBar reads filtered.length, rendered outside .pad, and the server page no longer duplicates it", () => {
    const src = read("app/c/orders/_components/OrdersClient.tsx");
    expect(src).toMatch(/<TopBar title="My Orders" sub=\{`\$\{filtered\.length\} total`\} \/>/);
    const topBarIdx = src.indexOf('<TopBar title="My Orders"');
    const padIdx = src.indexOf('<div className="pad">');
    expect(topBarIdx).toBeGreaterThan(-1);
    expect(padIdx).toBeGreaterThan(topBarIdx);
    const page = read("app/c/orders/page.tsx");
    expect(page).not.toMatch(/<TopBar/);
  });
});

describe("CSP allows the Sentry SDK's blob: worker, found via a live triggered error in the browser", () => {
  it("worker-src explicitly allows 'self' and blob:", () => {
    const src = read("next.config.ts");
    expect(src).toMatch(/"worker-src 'self' blob:"/);
  });
});

describe("campus-boundary sweep: server-component pages that build their own queries now scope them too", () => {
  it("customer and order detail pages redirect if the viewing staff's campus doesn't match the record's", () => {
    const cust = read("app/s/customers/[id]/page.tsx");
    expect(cust).toMatch(/if \(staff\.collegeId && staff\.collegeId !== student\.collegeId\) redirect\("\/s\/students"\)/);
    const ord = read("app/s/orders/[id]/page.tsx");
    expect(ord).toMatch(/if \(staff\.collegeId && staff\.collegeId !== order\.collegeId\) redirect\("\/s"\)/);
  });

  it("staff home dashboard scopes every one of its 6 queries to the viewing staff's own campus", () => {
    const src = read("app/s/page.tsx");
    expect(src).toMatch(/const scope = staff\.collegeId \? \{ collegeId: staff\.collegeId \} : \{\};/);
    expect((src.match(/\.\.\.scope/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/active: false, \.\.\.\(staff\.collegeId \? \{ student: \{ collegeId: staff\.collegeId \} \} : \{\}\)/);
    expect(src).toMatch(/active: true, \.\.\.\(staff\.collegeId \? \{ student: \{ collegeId: staff\.collegeId \} \} : \{\}\)/);
  });

  it("students roster page scopes the student list and the college picker", () => {
    const src = read("app/s/students/page.tsx");
    expect(src).toMatch(/const scope = \{ anonymisedAt: null, \.\.\.\(staff\.collegeId \? \{ collegeId: staff\.collegeId \} : \{\}\) \};/);
    expect(src).toMatch(/db\.student\.findMany\(\{\s*\n\s*where: scope,/);
  });

  it("complaints list scopes to the staff member's own campus", () => {
    const src = read("app/s/complaints/page.tsx");
    expect(src).toMatch(/where: staff\.collegeId \? \{ collegeId: staff\.collegeId \} : undefined,/);
  });

  it("admin page scopes staff roster, payslips, plans, attendance and slot windows for a non-Owner", () => {
    const src = read("app/s/admin/page.tsx");
    expect(src).toMatch(/const staffScope = staff\.collegeId \? \{ collegeId: staff\.collegeId \} : \{\};/);
    expect(src).toMatch(/db\.staff\.findMany\(\{ where: staffScope/);
    expect(src).toMatch(/db\.payslip\.findMany\(\{ where: staff\.collegeId \? \{ staff: staffScope \} : \{\}/);
    expect(src).toMatch(/db\.plan\.findMany\(\{ where: staffScope/);
    expect(src).toMatch(/db\.slotWindow\.findMany\(\{\s*\n\s*where: staffScope,/);
  });

  it("the SSE realtime stream only subscribes staff to their own campus's channel", () => {
    const src = read("app/api/rt/route.ts");
    expect(src).toMatch(/const staff = await db\.staff\.findUnique\(\{ where: \{ id: s\.staffId \}, select: \{ collegeId: true \} \}\)/);
    expect(src).toMatch(/\.\.\.\(staff\?\.collegeId \? \{ id: staff\.collegeId \} : \{\}\)/);
  });

  it("reports page's analytics widgets (below the already-scoped headline report) are scoped too", () => {
    // Renamed from staff.collegeId to selectedCollegeId when the Owner
    // per-campus report switcher was added — same scoping, now also
    // respects an Owner's chosen campus, not just a scoped staffer's own.
    const src = read("app/s/reports/page.tsx");
    expect(src).toMatch(/at: \{ gte: new Date\(now - 8 \* weekMs\) \}, \.\.\.\(selectedCollegeId \? \{ collegeId: selectedCollegeId \} : \{\}\)/);
    expect(src).toMatch(/db\.subscription\.count\(\{ where: \{ active: true, \.\.\.\(selectedCollegeId \? \{ student: \{ collegeId: selectedCollegeId \} \} : \{\}\) \} \}\)/);
  });
});

describe("three previously-uncovered functions have their key invariants locked in", () => {
  const orders = read("lib/actions/orders.ts");
  const subs = read("lib/actions/subscription.ts");

  it("recordPay checks the campus boundary, clamps applied credit, and refuses a GST bill on a no-GST order", () => {
    const fn = orders.slice(orders.indexOf("export async function recordPay"), orders.indexOf("export async function recordPay") + 900);
    expect(fn).toMatch(/assertSameCollege\(st, o\.collegeId\)/);
    expect(fn).toMatch(/Math\.min\(Number\(o\.student\.credits\), Number\(o\.total\)\)/);
    expect(fn).toMatch(/if \(staffInvoice && o\.noGst\) return \{ ok: false as const, error: "This order was billed without GST — no invoice can be issued" \}/);
  });

  it("scanTag checks the campus boundary and rejects a tag that doesn't belong to this order", () => {
    const fn = orders.slice(orders.indexOf("export async function scanTag"), orders.indexOf("export async function scanTag") + 700);
    expect(fn).toMatch(/assertSameCollege\(st, ord\.collegeId\)/);
    expect(fn).toMatch(/if \(!tag \|\| tag\.orderId !== orderId\) return \{ ok: false as const, error: "Tag not found on this order" \}/);
  });

  it("cancelSubscriptionRequest only deletes a PENDING (not-yet-active) request, never a live plan", () => {
    const fn = subs.slice(subs.indexOf("export async function cancelSubscriptionRequest"), subs.indexOf("export async function cancelSubscriptionRequest") + 500);
    expect(fn).toMatch(/if \(stu\.subscription && !stu\.subscription\.active\) \{/);
    expect(fn).toMatch(/db\.subscription\.delete\(\{ where: \{ id: stu\.subscription\.id \} \}\)/);
  });
});

describe("high-traffic pages cap unbounded lists and avoid over-fetching full relations", () => {
  it("staff complaints list is capped and selects only rendered fields", () => {
    const src = read("app/s/complaints/page.tsx");
    expect(src).toMatch(/take: 300/);
    expect(src).toMatch(/select: \{/);
  });
  it("customer help and notifications history is capped", () => {
    expect(read("app/c/help/page.tsx")).toMatch(/take: 50/);
    expect(read("app/c/notifications/page.tsx")).toMatch(/take: 50/);
  });
  it("staff home's order queue selects only the student fields it renders", () => {
    const src = read("app/s/page.tsx");
    expect(src).toMatch(/student: \{ select: \{ id: true, name: true, phone: true, collegeId: true \} \}/);
    expect(src).toMatch(/student: \{ select: \{ id: true, name: true, collegeId: true \} \}/);
  });
});

describe("/login is not promoted for indexing via the sitemap", () => {
  it("sitemap's page list no longer includes /login", () => {
    const src = read("app/sitemap.ts");
    expect(src).not.toMatch(/"\/login"/);
  });
});

describe("Sheet is a real dialog: focus moves in, Escape closes it, focus returns on close", () => {
  it("has role=dialog/aria-modal and an Escape key handler", () => {
    const src = read("components/chrome.tsx");
    const fn = src.slice(src.indexOf("export function Sheet"));
    expect(fn).toMatch(/role="dialog"\s+aria-modal="true"/);
    expect(fn).toMatch(/e\.key === "Escape"/);
    expect(fn).toMatch(/panelRef\.current\?\.focus\(\)/);
    expect(fn).toMatch(/restoreFocusTo\.current\?\.focus\?\.\(\)/);
  });
});

describe("light-theme muted/faint text colors clear WCAG AA contrast", () => {
  it("--muted and --faint are darkened from the failing originals", () => {
    const src = read("app/globals.css");
    expect(src).toMatch(/--muted:#5c6b65; --faint:#6c7973;/);
  });
});

describe("the service worker's offline navigation fallback stays inside the right app", () => {
  it("falls back to /s or /c based on the path, not unconditionally to the marketing homepage", () => {
    const src = read("public/sw.js");
    expect(src).toMatch(/url\.pathname\.startsWith\("\/s"\) \? "\/s" : url\.pathname\.startsWith\("\/c"\) \? "\/c" : "\/"/);
  });
});

describe("offline-queued cycle-based walk-ins keep their cycle count on replay", () => {
  it("QueuedIntake declares cycles, and OfflineBanner forwards it to walkInOrder", () => {
    const queueSrc = read("lib/offline-queue.ts");
    expect(queueSrc).toMatch(/cycles\?: number;/);
    const bannerSrc = read("components/offline.tsx");
    expect(bannerSrc).toMatch(/service: row\.service,\s*\n\s*cycles: row\.cycles,/);
  });
});

describe("invoice export checks staff campus, not just customer ownership", () => {
  it("staff sessions go through requireStaff + assertSameCollege against the order's campus", () => {
    const src = read("app/api/export/invoice/[orderId]/route.ts");
    expect(src).toMatch(/if \(s\.mode === "staff"\) \{/);
    expect(src).toMatch(/assertSameCollege\(st, inv\.order\.collegeId\)/);
  });

  it("prints the real Customer ID (self-healing), not the raw internal student.id", () => {
    // Used to print `(FF ID ${o.student.id})` directly on a legal GST
    // document — the raw internal reference, leftover-labeled from the old
    // "FF"-prefixed order-id scheme, and doubly wrong once order ids became
    // short sequential numbers. Found in the same sweep that caught the
    // Sheet-sync instances of this bug (owner, Sep 2026: "I should not see
    // any more bugs later").
    const src = read("app/api/export/invoice/[orderId]/route.ts");
    expect(src).toMatch(/const \{ customerIdFor \} = await import\("@\/lib\/bagcode"\)/);
    expect(src).toMatch(/Customer ID \$\{customerId\}/);
    expect(src).not.toMatch(/FF ID \$\{o\.student\.id\}/);
  });
});

describe("customer statement export prints the real Customer ID too", () => {
  it("resolves via customerIdFor instead of the raw stu.id", () => {
    const src = read("app/api/export/statement/route.ts");
    expect(src).toMatch(/const \{ customerIdFor \} = await import\("@\/lib\/bagcode"\)/);
    expect(src).toMatch(/\$\{stu\.name\} \(\$\{customerId\}\)/);
    expect(src).not.toMatch(/\$\{stu\.name\} \(\$\{stu\.id\}\)/);
  });
});

describe("order ids are simple, sequential, and never reused", () => {
  /* Owner, Sep 2026: "make order numbers simple not like FF563966 and make
     them unique everytime for both colleges. it should not be repeated
     anytime soon can start with 3 or 4 dight code and then continue so on".
     nextOrderId() replaced the old "FF" + 6 random digits scheme with a
     single global FySequence counter (same table/pattern lib/bagcode.ts
     uses for bag codes), starting at 1001. Old "FF######" ids already in
     the database are untouched — an id is a primary key, never renumbered —
     new orders just start using the short form going forward. */
  it("uses one global FySequence counter, not per-college numbering", () => {
    const src = read("lib/actions/orders.ts");
    const fn = src.slice(src.indexOf("async function nextOrderId"), src.indexOf("async function nextOrderId") + 800);
    expect(fn).toMatch(/const KIND = "orderid", TAG = "global", BASELINE = 1000/);
    expect(fn).toMatch(/value: \{ increment: 1 \}/);
  });

  it("the old random 'FF' + digits generator is gone", () => {
    const src = read("lib/actions/orders.ts");
    expect(src).not.toMatch(/"FF" \+ rid\(6\)/);
    expect(src).not.toMatch(/const orderCode = /);
  });

  it("all three order-creation call sites use nextOrderId, not the old generator", () => {
    const src = read("lib/actions/orders.ts");
    // placeOrder
    const placeOrderFn = src.slice(src.indexOf("export async function placeOrder"), src.indexOf("export async function acceptOrder"));
    expect(placeOrderFn).toMatch(/id: await nextOrderId\(tx\)/);
    // walkInOrder
    const walkInFn = src.slice(src.indexOf("export async function walkInOrder"), src.indexOf("export async function walkInOrder") + 6000);
    expect(walkInFn).toMatch(/const id = await nextOrderId\(tx\)/);
    // redoOrder
    const redoFn = src.slice(src.indexOf("export async function redoOrder"), src.indexOf("export async function redoOrder") + 2000);
    expect(redoFn).toMatch(/id: await nextOrderId\(db\)/);
  });
});

describe("createPayslip can't double-pay a staff member for the same month", () => {
  // The @@unique([staffId, month]) DB constraint is verified safe (zero
  // duplicates found in production, 2026-09-05) but NOT yet applied —
  // `prisma db push` refuses it categorically without --accept-data-loss,
  // and that flag isn't ours to add without the owner's explicit hand on
  // it. See the note in prisma/schema.prisma for the exact SQL to run.
  // Since the DB constraint doesn't exist, the old P2002-only catch had
  // NOTHING to actually catch in production — fixed 2026-09-05 with an
  // application-level Postgres advisory lock (same technique as the
  // slot-booking overbooking fix) plus an explicit findFirst check inside
  // the lock, closing the race without needing the blocked migration.
  it("locks on (staffId, month) and checks for an existing payslip before creating one", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function createPayslip"));
    expect(fn).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\$\{`payslip\|\$\{input\.staffId\}\|\$\{input\.month\}`\}\)\)/);
    expect(fn).toMatch(/if \(await tx\.payslip\.findFirst\(\{ where: \{ staffId: input\.staffId, month: input\.month \} \}\)\)/);
  });
  it("still catches a real P2002 too, in case the DB constraint is ever added", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function createPayslip"));
    expect(fn).toMatch(/"DUPLICATE_PAYSLIP" \|\| \(e as \{ code\?: string \}\)\.code === "P2002"/);
  });
});

describe("collectOrder can't skip straight from received/processing to collected", () => {
  it("requires status === \"ready\" before it will even try the transaction", () => {
    const src = read("lib/actions/orders.ts");
    const fn = src.slice(src.indexOf("export async function collectOrder"), src.indexOf("export async function payOrder"));
    expect(fn).toMatch(/if \(o\.status !== "ready"\) return \{ ok: false as const, error: `Order is \$\{o\.status\}, not ready for collection` \};/);
    expect(fn).toMatch(/tx\.order\.updateMany\(\{ where: \{ id: o\.id, status: "ready" \}, data: \{ status: "collected" \} \}\)/);
  });
});

describe("collectOrder blocks an unpaid order for BVRIT or faculty, but not a regular St Mary's student", () => {
  /* Payment-timing rule (owner, Sep 2026): "for bvrit payment is mandatory
     we cant deliver unless payment is done or recorded unless it is
     complaint order" AND "payment is mandatory for st marys staff as we
     dont charge on subscription basis". A regular St Mary's STUDENT
     explicitly keeps the earlier rule (pay before or after collection, no
     restriction) — this is a college/kind-specific carve-out, not a
     reversal of that. Faculty (any college) buy cycle packs, not a
     subscription plan, so there is no "billed on the plan" cover a regular
     subscribed student has — same reasoning as BVRIT's per-piece billing.
     A free re-do (complaint compensation) is created with paid: true
     already, so the "unless it is complaint order" exemption falls out of
     the plain `!o.paid` check with no separate flag needed. */
  it("checks BVRIT OR faculty kind before the ready-status check", () => {
    const src = read("lib/actions/orders.ts");
    const fn = src.slice(src.indexOf("export async function collectOrder"), src.indexOf("export async function payOrder"));
    const gate = fn.indexOf('const paymentMandatory = college?.name.trim().toUpperCase() === "BVRIT" || orderStu?.kind === "faculty"');
    const readyCheck = fn.indexOf('if (o.status !== "ready")');
    expect(gate).toBeGreaterThan(-1);
    expect(readyCheck).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(readyCheck); // the money check runs before the status check
    expect(fn).toMatch(/if \(paymentMandatory && !o\.paid && Number\(o\.total\) > 0\) \{\s*return \{ ok: false as const, error: "Record payment before collection" \};/);
  });
});

describe("redoOrder refuses a draft or already-cancelled order", () => {
  it("checks status before creating the free re-do", () => {
    const src = read("lib/actions/orders.ts");
    const fn = src.slice(src.indexOf("export async function redoOrder"), src.indexOf("export async function redoOrder") + 1500);
    expect(fn).toMatch(/if \(o\.status === "draft" \|\| o\.status === "cancelled"\)/);
  });
});

describe("weekly-digest cron won't double-email the owner on a retried trigger", () => {
  it("checks and stamps lastWeeklyDigestAt in AppConfig.settings", () => {
    const src = read("app/api/cron/weekly-digest/route.ts");
    expect(src).toMatch(/if \(lastSent && Date\.now\(\) - lastSent\.getTime\(\) < 6 \* 86_400_000\)/);
    expect(src).toMatch(/lastWeeklyDigestAt: new Date\(\)\.toISOString\(\)/);
  });
});

describe("a WhatsApp send failure is persisted, not just console.error'd into the void", () => {
  it("logWaFailure writes to ErrorLog and is called from every failure branch", () => {
    const src = read("lib/notify.ts");
    expect(src).toMatch(/async function logWaFailure\(message: string\) \{/);
    expect(src).toMatch(/db\.errorLog\.create\(\{ data: \{ kind: "server", message: `WhatsApp: \$\{message\}`/);
    expect((src.match(/await logWaFailure\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("adjustCycleUsage locks the subscription row before writing buckets", () => {
  it("uses SELECT ... FOR UPDATE inside a transaction, re-reading fresh", () => {
    const src = read("lib/actions/subscription.ts");
    const fn = src.slice(src.indexOf("export async function adjustCycleUsage"), src.indexOf("async function planGross"));
    expect(fn).toMatch(/FOR UPDATE`/);
    expect(fn).toMatch(/const fresh = await tx\.subscription\.findUniqueOrThrow/);
  });
});

describe("two more campus-boundary bypasses closed (privacy + slot windows)", () => {
  it("eraseStudentData checks the requesting staff's own campus", () => {
    const src = read("lib/actions/privacy.ts");
    const fn = src.slice(src.indexOf("export async function eraseStudentData"));
    expect(fn).toMatch(/assertSameCollege\(st, stu\.collegeId\)/);
  });
  it("saveSlotWindow/toggleSlotWindow/deleteSlotWindow all check campus ownership", () => {
    const src = read("lib/actions/slots.ts");
    expect((src.match(/assertSameCollege\(st, /g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("retireBag can't have its status raced by two near-simultaneous calls", () => {
  it("claims atomically on status still being 'active'", () => {
    const src = read("lib/actions/bags.ts");
    const fn = src.slice(src.indexOf("export async function retireBag"));
    expect(fn).toMatch(/db\.bag\.updateMany\(\{\s*\n\s*where: \{ id: bagId, status: "active" \}/);
    expect(fn).toMatch(/if \(claimed\.count === 0\)/);
  });
});

describe("AdminClient's shared run() helper can't double-submit", () => {
  it("guards re-entrancy and disables the triggering buttons while busy", () => {
    const src = read("app/s/admin/_components/AdminClient.tsx");
    expect(src).toMatch(/const \[runBusy, setRunBusy\] = useState\(false\)/);
    expect(src).toMatch(/if \(runBusy\) return;/);
    expect((src.match(/disabled=\{runBusy\}/g) || []).length).toBeGreaterThanOrEqual(9);
  });
});

describe("financialYearTag is IST-aware, not server-local UTC", () => {
  it("shifts into IST before deriving the FY, matching istToday()'s pattern", () => {
    const src = read("lib/money.ts");
    expect(src).toMatch(/new Date\(base \+ 5\.5 \* 3600_000\)/);
    expect(src).toMatch(/dt\.getUTCMonth\(\) >= 3/);
  });
});

describe("Excel student import caps row count like the text-paste import does", () => {
  it("rejects a sheet with more than 500 data rows before processing it", () => {
    const src = read("app/api/import/students/route.ts");
    expect(src).toMatch(/if \(ws\.rowCount - 1 > 500\)/);
  });
});

describe("OTP verification uses a timing-safe comparison, not ===", () => {
  it("compares code buffers with crypto.timingSafeEqual, guarded by a length check", () => {
    const src = read("lib/actions/auth.ts");
    expect(src).toMatch(/submitted\.length === otp\.code\.length &&\s*\n\s*crypto\.timingSafeEqual\(Buffer\.from\(otp\.code\), Buffer\.from\(submitted\)\)/);
    expect(src).not.toMatch(/if \(otp\.code !== code\.trim\(\)\)/);
  });
});

describe("submitComplaint can't be attached to someone else's order", () => {
  it("looks up the order and rejects if it isn't the caller's", () => {
    const src = read("lib/actions/complaints.ts");
    const fn = src.slice(src.indexOf("export async function submitComplaint"), src.indexOf("export async function sendComplaintMessage"));
    expect(fn).toMatch(/const o = await db\.order\.findUnique\(\{ where: \{ id: orderId \}, select: \{ studentId: true \} \}\)/);
    expect(fn).toMatch(/if \(!o \|\| o\.studentId !== stu\.id\) return \{ ok: false as const, error: "Not your order" \}/);
  });
});

describe("two customer-facing reliability fixes", () => {
  it("wallet page: per-bucket progress bar can't divide by zero", () => {
    const src = read("app/c/wallet/page.tsx");
    expect(src).toMatch(/\(b\.cycles - b\.used\) \/ Math\.max\(1, b\.cycles\)/);
  });
  it("pay page: an already-paid order redirects instead of showing a live checkout", () => {
    const src = read("app/c/pay/[id]/page.tsx");
    expect(src).toMatch(/if \(order\.paid\) redirect\(`\/c\/orders\/\$\{order\.id\}`\)/);
  });
});

describe("sessions last a year, not 30 days, but the epoch kill-switch still works", () => {
  const src = read("lib/auth.ts");

  it("createSession mints a 365-day token and cookie", () => {
    expect(src).toMatch(/const SESSION_LIFETIME = "365d"/);
    expect(src).toMatch(/const SESSION_MAX_AGE = 60 \* 60 \* 24 \* 365/);
    expect(src).toMatch(/\.setExpirationTime\(SESSION_LIFETIME\)/);
    expect(src).toMatch(/maxAge: SESSION_MAX_AGE/);
  });

  it("the WhatsApp claim-cookie TTLs (a different, short-lived mechanism) are untouched", () => {
    const waLogin = read("lib/actions/wa-login.ts");
    const waRegister = read("lib/actions/wa-register.ts");
    expect(waLogin).toMatch(/maxAge: Math\.ceil\(TTL_MS \/ 1000\)/);
    expect(waRegister).toMatch(/maxAge: Math\.ceil\(TTL_MS \/ 1000\)/);
  });

  it("deactivation/role-change/sign-out-everywhere still ends access immediately regardless of token life", () => {
    expect(src).toMatch(/\(s\.epoch \?\? 0\) !== stu\.sessionEpoch/);
    expect(src).toMatch(/\(s\.epoch \?\? 0\) !== st\.sessionEpoch/);
  });
});

describe("assignSubscription's bagError is surfaced to staff, not silently dropped", () => {
  it("CustomerClient reads r.bagError and warns instead of showing a plain success toast", () => {
    const src = read("app/s/customers/[id]/_components/CustomerClient.tsx");
    expect(src).toMatch(/if \(r\.bagError\)/);
    expect(src).toMatch(/bag issue failed/);
  });
});

describe("/s/audit redirects a too-junior staff member instead of crashing", () => {
  it("no longer calls the throwing requireStaff(3)", () => {
    const src = read("app/s/audit/page.tsx");
    // Strip comments first: the fix's own explanatory comment mentions the
    // old call by name ("Was requireStaff(3), which THROWS...") — a plain
    // substring check would trip on that prose, not just a real call site.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/requireStaff\(/);
  });

  it("checks the role explicitly and redirects to /s, matching admin and reports", () => {
    const src = read("app/s/audit/page.tsx");
    expect(src).toMatch(/if \(staff\.role < 3\) redirect\("\/s"\)/);
  });
});

describe("the daily report cron guards a retry, but never swallows a deliberate manual send", () => {
  const src = read("app/api/report/daily/route.ts");

  it("the cron GET path passes guardRetries=true", () => {
    const fn = src.slice(src.indexOf("export async function GET"), src.indexOf("async function run"));
    expect(fn).toMatch(/return run\(true\)/);
  });

  it("the manual POST path passes guardRetries=false — a staff click must always go through", () => {
    const fn = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function GET"));
    expect(fn).toMatch(/return run\(false\)/);
  });

  it("the guard only applies when guardRetries is true", () => {
    expect(src).toMatch(/if \(guardRetries && lastSent/);
  });
});

describe("campus QR sign-in pages (Sep 2026): both colleges get one URL that works for staff and customers alike", () => {
  it("/join/bvrit and /join/stmarys both send an already-logged-in visitor straight to their app", () => {
    for (const p of ["app/join/bvrit/page.tsx", "app/join/stmarys/page.tsx"]) {
      const src = read(p);
      expect(src).toMatch(/if \(s\?\.mode === "customer"\) redirect\("\/c"\)/);
      expect(src).toMatch(/if \(s\?\.mode === "staff"\) redirect\("\/s"\)/);
    }
  });

  it("both pages reuse startWhatsAppLogin/checkWhatsAppLogin UNCHANGED for staff and returning customers — no second copy of that logic, no campus parameter that could scope it wrong", () => {
    for (const p of ["app/join/bvrit/_components/RegisterForm.tsx", "app/join/stmarys/_components/SignInForm.tsx"]) {
      const src = read(p);
      expect(src).toMatch(/import \{ startWhatsAppLogin, checkWhatsAppLogin \} from "@\/lib\/actions\/wa-login"/);
      // Neither call ever threads a collegeId through — startWhatsAppLogin takes
      // only a customer/staff mode, so an Admin (collegeId: null on their Staff
      // row) signing in from either campus page still gets full cross-campus
      // access, exactly as if they'd used /login.
      expect(src).not.toMatch(/startWhatsAppLogin\([^)]*collegeId/);
    }
  });

  it("BVRIT's registration form offers a 'sign in instead' fallback when the phone is already registered, rather than a dead end", () => {
    const src = read("app/join/bvrit/_components/RegisterForm.tsx");
    expect(src).toMatch(/sign in instead/i);
    expect(src).toMatch(/showSignInOffer/);
    expect(src).toMatch(/handleWhatsAppSignIn\("customer"\)/);
  });

  it("St Mary's page has no self-registration path — it only ever calls startWhatsAppLogin, matching the counter-only registration model", () => {
    const src = read("app/join/stmarys/_components/SignInForm.tsx");
    expect(src).not.toMatch(/startWhatsAppRegister/);
    expect(src).toMatch(/Visit your campus counter to get registered/);
  });

  it("both pages offer a staff-mode toggle using the same corner-link pattern as /login", () => {
    for (const p of ["app/join/bvrit/_components/RegisterForm.tsx", "app/join/stmarys/_components/SignInForm.tsx"]) {
      const src = read(p);
      expect(src).toMatch(/Staff sign-in/);
      expect(src).toMatch(/startWhatsAppLogin\(/);
    }
  });

  it("public marketing CTAs point at /get (install-first), not directly at /login — /login is hidden from discovery but still reachable", () => {
    const marketingFiles = [
      "app/_components/marketing/Shell.tsx",
      "app/_components/marketing/MobileNav.tsx",
      "app/_components/marketing/Home.tsx",
      "app/contact/page.tsx",
      "app/hostel-laundry/page.tsx",
      "app/how-it-works/page.tsx",
    ];
    for (const p of marketingFiles) {
      const src = read(p);
      expect(src).not.toMatch(/href="\/login"/);
    }
    // /get itself still offers /login as InstallButton's launch-the-installed-app
    // fallback, and now also links to both campus sign-in pages directly.
    const getPage = read("app/get/page.tsx");
    expect(getPage).toMatch(/href="\/join\/bvrit"/);
    expect(getPage).toMatch(/href="\/join\/stmarys"/);
  });
});

describe("sessions extended to 1 year (Sep 2026, owner: 'should stay until user logout')", () => {
  // Covered in the "sessions last a year" describe block above (lib/auth.ts);
  // this block locks in the campus-page-specific angle: neither new page
  // mints its own session or duplicates createSession's expiry logic.
  it("neither campus page calls createSession directly — session minting stays centralized in wa-login.ts/wa-register.ts", () => {
    for (const p of ["app/join/bvrit/_components/RegisterForm.tsx", "app/join/stmarys/_components/SignInForm.tsx"]) {
      expect(read(p)).not.toMatch(/createSession/);
    }
  });
});

describe("account erasure now refreshes the Sheet roster immediately, matching registration's own behavior", () => {
  const src = read("lib/actions/privacy.ts");

  it("imports rosterSoon from the same module registerStudent uses", () => {
    expect(src).toMatch(/import \{ rosterSoon \} from "\.\.\/sheets-sync"/);
  });

  it("eraseMyData (self-service) calls rosterSoon after anonymising", () => {
    const fn = src.slice(src.indexOf("export async function eraseMyData"), src.indexOf("export async function eraseStudentData"));
    const anonAt = fn.indexOf("anonymisedFields(stu.id)");
    const rosterAt = fn.indexOf("rosterSoon()");
    expect(rosterAt).toBeGreaterThan(anonAt); // fires AFTER the write commits
  });

  it("eraseStudentData (staff/Admin) calls rosterSoon after anonymising", () => {
    const fn = src.slice(src.indexOf("export async function eraseStudentData"));
    const anonAt = fn.indexOf("anonymisedFields(stu.id)");
    const rosterAt = fn.indexOf("rosterSoon()");
    expect(rosterAt).toBeGreaterThan(anonAt);
  });

  it("writeStudentsTab already excludes anonymised rows — the fix was purely about WHEN that takes effect, not what it excludes", () => {
    const sync = read("lib/sheets-sync.ts");
    expect(sync).toMatch(/where: \{ anonymisedAt: null \}/);
  });
});
