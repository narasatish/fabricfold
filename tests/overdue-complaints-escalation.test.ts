/* 2026-11-01: owner's complaint was "staff are ignoring complaints" — the
   "Overdue" badge on the staff complaints screen only matters if someone
   opens that screen. This cron (app/api/cron/overdue-complaints/route.ts)
   is the active half: it emails the owner once a complaint passes its
   respondBy deadline, so inaction surfaces instead of staying silent on a
   list view. This suite proves the two behaviors that matter: (1) a
   genuinely overdue, unresolved complaint triggers the owner email and
   gets escalatedAt stamped, and (2) a complaint already escalated is never
   re-emailed on a later run — the idempotency the whole feature depends on
   to avoid flooding the owner's inbox every time the cron fires. */
import "dotenv/config";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../lib/db";

const COLLEGE_ID = "overduecx-college";
const STUDENT_ID = "overduecx-stu";

beforeAll(async () => {
  await db.college.upsert({
    where: { id: COLLEGE_ID },
    create: { id: COLLEGE_ID, name: "Overdue Complaints College", address: "x", features: {} },
    update: {},
  });
  await db.student.upsert({
    where: { id: STUDENT_ID },
    create: { id: STUDENT_ID, phone: "9000000091", name: "Overdue Test Student", collegeId: COLLEGE_ID },
    update: {},
  });
});

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(async () => {
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.OWNER_EMAIL = "owner@example.test";
  process.env.CRON_SECRET = "test-overdue-secret";
  await db.complaint.deleteMany({ where: { studentId: STUDENT_ID } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_EMAIL;
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  await db.complaint.deleteMany({ where: { studentId: STUDENT_ID } });
});

function req() {
  return new Request("https://x.test/api/cron/overdue-complaints", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

describe("overdue-complaints escalation", () => {
  it("emails the owner and stamps escalatedAt for a genuinely overdue, unescalated complaint", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const c = await db.complaint.create({
      data: {
        studentId: STUDENT_ID, collegeId: COLLEGE_ID, text: "Shirt torn in the wash",
        respondBy: new Date(Date.now() - 3_600_000), // 1h past deadline
      },
    });

    const { GET } = await import("../app/api/cron/overdue-complaints/route");
    const res = await GET(req());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.overdue).toBe(1);
    expect(fetchMock).toHaveBeenCalled(); // notifyOwner sent

    const after = await db.complaint.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.escalatedAt).not.toBeNull();
  });

  it("does not re-email an already-escalated complaint on a later run", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await db.complaint.create({
      data: {
        studentId: STUDENT_ID, collegeId: COLLEGE_ID, text: "Already escalated once",
        respondBy: new Date(Date.now() - 7_200_000),
        escalatedAt: new Date(Date.now() - 3_600_000),
      },
    });

    const { GET } = await import("../app/api/cron/overdue-complaints/route");
    const res = await GET(req());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.overdue).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not flag a complaint that is still within its respond-by window", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await db.complaint.create({
      data: {
        studentId: STUDENT_ID, collegeId: COLLEGE_ID, text: "Still on time",
        respondBy: new Date(Date.now() + 3_600_000), // 1h from now
      },
    });

    const { GET } = await import("../app/api/cron/overdue-complaints/route");
    const res = await GET(req());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.overdue).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request without the cron secret or staff session", async () => {
    const { GET } = await import("../app/api/cron/overdue-complaints/route");
    const res = await GET(new Request("https://x.test/api/cron/overdue-complaints"));
    expect(res.status).toBe(401);
  });
});
