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
    const src = read("app/s/reports/page.tsx");
    expect(src).toMatch(/computeReport\(period, staff\.collegeId\)/);
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
