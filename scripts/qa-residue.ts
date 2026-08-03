/* Report (and where permitted, remove) anything the QA pipeline left behind.
   Payment rows are immutable by DB trigger, so they are reported, not deleted. */
import "dotenv/config";
import { db } from "../lib/db";

const TAG = "qapipe";

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("DB host:", (url.match(/@([^/?]+)/) || [])[1] || "unknown");

  const counts = {
    students: await db.student.count({ where: { id: { startsWith: TAG } } }),
    payments: await db.payment.count({ where: { studentId: { startsWith: TAG } } }),
    orders: await db.order.count({ where: { studentId: { startsWith: TAG } } }),
    bags: await db.bag.count({ where: { studentId: { startsWith: TAG } } }),
    colleges: await db.college.count({ where: { id: { startsWith: TAG } } }),
    subs: await db.subscription.count({ where: { studentId: { startsWith: TAG } } }),
    complaints: await db.complaint.count({ where: { studentId: { startsWith: TAG } } }),
  };
  console.log("before:", counts);

  const ids = (await db.student.findMany({ where: { id: { startsWith: TAG } }, select: { id: true } })).map((s) => s.id);
  if (ids.length) {
    const comps = await db.complaint.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await db.complaintMessage.deleteMany({ where: { complaintId: { in: comps.map((c) => c.id) } } });
    await db.complaint.deleteMany({ where: { studentId: { in: ids } } });
    const subs = await db.subscription.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await db.cycleUse.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await db.subscription.deleteMany({ where: { studentId: { in: ids } } });
    await db.bag.deleteMany({ where: { studentId: { in: ids } } });
    await db.orderEvent.deleteMany({ where: { order: { studentId: { in: ids } } } });
    await db.order.deleteMany({ where: { studentId: { in: ids } } });
    await db.notification.deleteMany({ where: { studentId: { in: ids } } });
  }

  const stuck = await db.payment.count({ where: { studentId: { startsWith: TAG } } });
  if (stuck === 0) {
    await db.student.deleteMany({ where: { id: { startsWith: TAG } } });
    await db.college.deleteMany({ where: { id: { startsWith: TAG } } });
  } else {
    console.log(
      `\n${stuck} QA payment row(s) remain: the ledger is immutable by DB trigger, which is correct.\n` +
        `Their student + college rows must stay too (foreign key). They are tagged "${TAG}" and\n` +
        `are inert — no plan, no bag, no orders. Leaving them is safer than weakening the trigger.`,
    );
  }

  console.log("after:", {
    students: await db.student.count({ where: { id: { startsWith: TAG } } }),
    payments: await db.payment.count({ where: { studentId: { startsWith: TAG } } }),
    orders: await db.order.count({ where: { studentId: { startsWith: TAG } } }),
    bags: await db.bag.count({ where: { studentId: { startsWith: TAG } } }),
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
