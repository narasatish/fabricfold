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
    expect(src).toMatch(/computeReport\(p, me\.collegeId\)/);
    expect(src).toMatch(/db\.staff\.findMany\(me\.collegeId \? \{ where: \{ collegeId: me\.collegeId \} \} : undefined\)/);
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
  const fn = bagsSrc.slice(bagsSrc.indexOf("export async function issueBag"), bagsSrc.indexOf("export async function issueBag") + 5000);
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
  it("OrderClient: collect/pay/refund/compensation all share one busy guard", () => {
    const src = read("app/s/orders/[id]/_components/OrderClient.tsx");
    expect(src).toMatch(/const \[actionBusy, setActionBusy\] = useState\(false\)/);
    expect((src.match(/setActionBusy\(true\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/onClick=\{handleRefund\} disabled=\{actionBusy\}/);
    expect(src).toMatch(/onClick=\{handleCompensation\} disabled=\{actionBusy\}/);
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
      expect(src, f).toMatch(/disabled=\{compBusy\}/);
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
    const fn = orders.slice(orders.indexOf("export async function walkInOrder"), orders.indexOf("export async function walkInOrder") + 6000);
    expect(fn).toMatch(/tx\.cycleUse\.createMany\(\{ data: Array\.from\(\{ length: cyclesCount \}, \(\) => \(\{ subscriptionId: stu\.subscription!\.id, orderId: o\.id \}\)\) \}\)/);
  });

  it("subscription.ts's own row locks are schema-qualified too (the same raw-SQL gap fixed elsewhere tonight, missed here until now)", () => {
    expect((subs.match(/SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE "studentId" = \$\{studentId\} FOR UPDATE/g) || []).length).toBe(4);
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
    expect(src).toMatch(/const scope = staff\.collegeId \? \{ collegeId: staff\.collegeId \} : \{\};/);
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
    expect(fn).toMatch(/role="dialog" aria-modal="true"/);
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
});

describe("createPayslip can't double-pay a staff member for the same month", () => {
  // The @@unique([staffId, month]) DB constraint is verified safe (zero
  // duplicates found in production, 2026-09-05) but NOT yet applied —
  // `prisma db push` refuses it categorically without --accept-data-loss,
  // and that flag isn't ours to add without the owner's explicit hand on
  // it. See the note in prisma/schema.prisma for the exact SQL to run.
  it("createPayslip catches the collision and returns a friendly error", () => {
    const src = read("lib/actions/admin.ts");
    const fn = src.slice(src.indexOf("export async function createPayslip"));
    expect(fn).toMatch(/if \(\(e as \{ code\?: string \}\)\.code === "P2002"\) return \{ ok: false as const, error: `\$\{target\.name\} already has a payslip for \$\{input\.month\}` \};/);
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
