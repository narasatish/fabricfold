import { test, expect, beforeAll, afterAll, describe } from "vitest";
import { db } from "../lib/db";

/* Global test data: a fake session/staff ID. Skip all tests if not Postgres. */
let testStaffId = "";

describe.skipIf(!process.env.DATABASE_URL?.startsWith("postgres"))("attendance races", () => {
  beforeAll(async () => {
    const s = await db.staff.create({
      data: { id: "test-attendance-staff", phone: "9999988881", name: "Test Attendance", role: 1 },
    });
    testStaffId = s.id;
  });

  afterAll(async () => {
    if (testStaffId) {
      /* Clean up test staff. */
      await db.staff.delete({ where: { id: testStaffId } }).catch(() => {});
      /* Clean up attendance records. */
      await db.attendance.deleteMany({ where: { staffId: testStaffId } }).catch(() => {});
    }
  });

  test("double-tap clockIn hits P2002 which is now caught", async () => {
    /* Simulate a staff member double-tapping the "Clock In" button.
       Two concurrent requests both bypass the findUnique check and both
       try to create an Attendance record. Without the P2002 catch, the
       second one would throw an unhandled Prisma error. With the fix,
       it would return a friendly error message. Here we test the race
       directly at the Prisma level. */

    const date = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

    /* Clean up any leftover record from a prior test run. */
    await db.attendance.deleteMany({ where: { staffId: testStaffId, date } });

    /* Simulate two concurrent creates — one succeeds, the other hits P2002. */
    const [r1, r2] = await Promise.all([
      db.attendance.create({ data: { staffId: testStaffId, date } }).catch((e) => ({ error: (e as any)?.code })),
      db.attendance.create({ data: { staffId: testStaffId, date } }).catch((e) => ({ error: (e as any)?.code })),
    ]);

    /* One succeeds (no error field), the other hits P2002. */
    const results = [r1, r2];
    const successes = results.filter((r) => !("error" in r));
    const errors = results.filter((r) => (r as any)?.error === "P2002");

    expect(successes).toHaveLength(1);
    expect(errors).toHaveLength(1);

    /* Clean up. */
    await db.attendance.deleteMany({ where: { staffId: testStaffId, date } });
  });

  test("double-tap clockOut is atomic via updateMany WHERE condition", async () => {
    /* Simulate a staff member double-tapping "Clock Out".
       Two concurrent requests should both pass the initial checks, but
       only one should succeed in setting clockOut (due to the updateMany
       with a WHERE condition for clockOut: null). */

    const date = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

    /* Clean up and create a fresh attendance record. */
    await db.attendance.deleteMany({ where: { staffId: testStaffId, date } });
    const rec = await db.attendance.create({ data: { staffId: testStaffId, date } });

    /* Simulate two concurrent clockOut attempts using the atomic updateMany pattern. */
    const [r1, r2] = await Promise.all([
      db.attendance.updateMany({ where: { id: rec.id, clockOut: null }, data: { clockOut: new Date() } }),
      db.attendance.updateMany({ where: { id: rec.id, clockOut: null }, data: { clockOut: new Date() } }),
    ]);

    /* One updates (count === 1), the other doesn't (count === 0). */
    expect([r1.count, r2.count]).toContain(1);
    expect([r1.count, r2.count]).toContain(0);

    /* Clean up. */
    await db.attendance.deleteMany({ where: { staffId: testStaffId, date } });
  });
});
