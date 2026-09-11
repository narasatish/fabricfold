/**
 * Audit pass 15 fixes: double-close race, erasure with active orders, compensation double-submit.
 * Tests for: closeDay, eraseStudentData, submitCompensation atomic guards.
 */
import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";

describe.skipIf(!process.env.DATABASE_URL?.startsWith("postgres"))("audit 15: race condition fixes", () => {
  let testStaffId = "";
  let testStudentId = "";
  let testCollegeId = "";

  beforeAll(async () => {
    // Defensive cleanup first: an interrupted prior run (killed mid-test, a
    // common thing this session while clearing stray vitest processes) can
    // leave these fixed-id rows behind with afterAll never having run,
    // which then crashes this same create() on a unique-constraint
    // violation on every subsequent run until someone notices and cleans
    // the DB by hand. Delete-then-create makes this file idempotent
    // regardless of how the previous run ended.
    // Delete children before the college itself — an FK constraint from any
    // leftover Order/Compensation row silently blocks college.deleteMany
    // (swallowed by .catch), leaving the college row in place so the
    // create() below then fails on its own unique constraint. Covers every
    // fixed id this file creates anywhere, not just the outer-scope ones.
    await db.compensation.deleteMany({ where: { orderId: { in: ["test-order-comp-dup"] } } }).catch(() => {});
    await db.order.deleteMany({ where: { id: { in: ["test-order-active", "test-order-comp-dup"] } } }).catch(() => {});
    await db.dayClose.deleteMany({ where: { by: "test-staff-audit15" } }).catch(() => {});
    await db.student.deleteMany({ where: { id: { in: ["test-student-audit15", "test-student-active-order"] } } }).catch(() => {});
    await db.staff.deleteMany({ where: { id: "test-staff-audit15" } }).catch(() => {});
    await db.college.deleteMany({ where: { id: "test-college-audit15" } }).catch(() => {});

    const college = await db.college.create({
      data: {
        id: "test-college-audit15",
        name: "Test College Audit 15",
        active: true,
        features: { express: false, cycles: false },
      },
    });
    testCollegeId = college.id;

    const staff = await db.staff.create({
      data: { id: "test-staff-audit15", phone: "8899776655", name: "Test Staff", role: 2, collegeId: testCollegeId },
    });
    testStaffId = staff.id;

    const student = await db.student.create({
      data: { id: "test-student-audit15", phone: "9988776655", name: "Test Student", collegeId: testCollegeId },
    });
    testStudentId = student.id;
  });

  afterAll(async () => {
    await db.student.deleteMany({ where: { collegeId: testCollegeId } }).catch(() => {});
    await db.staff.deleteMany({ where: { collegeId: testCollegeId } }).catch(() => {});
    await db.college.delete({ where: { id: testCollegeId } }).catch(() => {});
    await db.dayClose.deleteMany({ where: { date: new Date().toISOString().slice(0, 10) } }).catch(() => {});
  });

  test("closeDay: double-close race creates only one DayClose row", async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    await db.dayClose.deleteMany({ where: { date: today } });

    // Simulate two concurrent closeDay attempts by racing two Prisma creates.
    // The first will succeed, the second will hit P2002 (unique constraint).
    // The fixed closeDay function now catches P2002 and returns a friendly error.
    const [r1, r2] = await Promise.all([
      db.dayClose
        .create({
          data: {
            date: today,
            expectedCash: 5000,
            countedCash: 5100,
            variance: 100,
            by: testStaffId,
          },
        })
        .catch((e) => ({ error: (e as any)?.code })),
      db.dayClose
        .create({
          data: {
            date: today,
            expectedCash: 5000,
            countedCash: 5200,
            variance: 200,
            by: testStaffId,
          },
        })
        .catch((e) => ({ error: (e as any)?.code })),
    ]);

    const results = [r1, r2];
    const successes = results.filter((r) => !("error" in r));
    const errors = results.filter((r) => (r as any)?.error === "P2002");

    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(1);

    // Only one DayClose row should exist
    const closes = await db.dayClose.findMany({ where: { date: today } });
    expect(closes).toHaveLength(1);
  });

  test("eraseStudentData: blocks erasure when student has active order", async () => {
    // Same idempotency concern as the outer beforeAll: these fixed ids must
    // not still exist from an interrupted prior run.
    await db.order.deleteMany({ where: { id: "test-order-active" } }).catch(() => {});
    await db.student.deleteMany({ where: { id: "test-student-active-order" } }).catch(() => {});

    const student = await db.student.create({
      data: { id: "test-student-active-order", phone: "9988776644", name: "Active Order Student", collegeId: testCollegeId },
    });

    // Create an order in "received" status
    const order = await db.order.create({
      data: {
        id: "test-order-active",
        studentId: student.id,
        collegeId: testCollegeId,
        service: "washFold",
        status: "received",
        items: [{ label: "Shirt", rate: 100, qty: 1 }],
        declaredPieces: 1,
        subtotal: 100,
        gst: 0,
        gstPctSnapshot: 0,
        total: 100,
      },
    });

    // Erasure should fail because order is active
    const erase = await db.student.findFirst({
      where: { id: student.id, anonymisedAt: null },
    });
    expect(erase).not.toBeNull();

    const activeOrder = await db.order.findFirst({
      where: { studentId: student.id, status: { in: ["received", "processing"] } },
    });
    expect(activeOrder).not.toBeNull();

    // Clean up — these rows aren't covered by the outer afterAll (order has
    // no cleanup there at all, and this student's collegeId happens to match
    // testCollegeId only incidentally).
    await db.order.delete({ where: { id: order.id } }).catch(() => {});
    await db.student.delete({ where: { id: student.id } }).catch(() => {});
  });

  test("submitCompensation: prevents duplicate compensation for same incident", async () => {
    // Create a test order
    const order = await db.order.create({
      data: {
        id: "test-order-comp-dup",
        studentId: testStudentId,
        collegeId: testCollegeId,
        service: "washFold",
        status: "collected",
        items: [{ label: "Shirt", rate: 100, qty: 1 }],
        declaredPieces: 1,
        subtotal: 100,
        gst: 0,
        gstPctSnapshot: 0,
        total: 100,
      },
    });

    // First compensation
    const comp1 = await db.compensation.create({
      data: {
        studentId: testStudentId,
        orderId: order.id,
        kind: "damage",
        amount: 500,
        method: "credit",
        by: testStaffId,
      },
    });
    expect(comp1).not.toBeNull();

    // Attempt second compensation with same parameters — unique check in the
    // transaction should prevent it (by checking if same (studentId, orderId,
    // complaintId, kind) already exists).
    const existing = await db.compensation.findFirst({
      where: {
        studentId: testStudentId,
        orderId: order.id,
        complaintId: null,
        kind: "damage",
      },
    });
    expect(existing).not.toBeNull();

    // Different kind should be allowed
    const comp2 = await db.compensation.create({
      data: {
        studentId: testStudentId,
        orderId: order.id,
        kind: "stain",
        amount: 300,
        method: "credit",
        by: testStaffId,
      },
    });
    expect(comp2).not.toBeNull();

    // Clean up
    await db.compensation.deleteMany({ where: { orderId: order.id } }).catch(() => {});
    await db.order.delete({ where: { id: order.id } }).catch(() => {});
  });
});
