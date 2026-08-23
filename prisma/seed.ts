/* Seed reproducing the prototype's seed() (FabricFold.html) — same colleges,
   students, staff, orders, payments, invoices, expenses, compensation, complaint. */
import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/client";

// Same adapter-by-URL logic as lib/db.ts so the seed runs on SQLite (dev) or Postgres (Supabase).
const url = process.env.DATABASE_URL || "file:./dev.db";
function makeAdapter() {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { PrismaPg } = require("@prisma/adapter-pg");
    /* Honour ?schema=… exactly as lib/db.ts does. Without this, a URL meant
       for an isolated schema silently seeds — and WIPES — public. The ledger
       triggers caught it once; they should not have had to. */
    const schema = new URL(url).searchParams.get("schema") || undefined;
    return new PrismaPg({ connectionString: url }, schema ? { schema } : undefined);
  }
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaBetterSqlite3({ url });
}
const db = new PrismaClient({ adapter: makeAdapter() });
const DAY = 86_400_000;
const HOUR = 3_600_000;
const EXPRESS_PCT = 0.4; // same-day surcharge = 40% of order value (all colleges)

const DEFAULT_FEATURES = {
  svc_wash: true, svc_washfold: true, svc_iron: true, svc_dryclean: true,
  subscriptions: true, credits: true, express: false, chat: true,
};

export const DEFAULT_RATES = {
  washIron: { label: "Wash & Iron", items: [["Regular garment", 15], ["Bed sheet", 25]] },
  washFold: { label: "Wash & Fold", items: [["Regular garment", 12], ["Bed sheet", 20]] },
  ironOnly: { label: "Iron Only", items: [["Shirt / T-shirt / Pant", 10], ["Ladies' top", 15], ["Saree", 30], ["Pyjama", 10], ["Blouse", 10], ["Dupatta", 10]] },
  dryClean: { label: "Dry Clean", items: [["Shirt / Pant / T-shirt", 100], ["Ladies' top", 129], ["Pyjama", 70], ["Dupatta", 60], ["Blouse (light)", 60], ["Blouse (medium)", 100], ["Blouse (heavy)", 140], ["Shoes / Sneakers", 350]] },
} as const;

function rid(n: number) { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
const orderCode = () => "FF" + rid(6);

async function main() {
  const t0 = Date.now();

  // wipe (dev convenience — safe: this is the seed)
  const tables = ["complaintMessage", "complaint", "notification", "creditUse", "compensation", "creditNote", "invoice", "payment", "garmentTag", "orderEvent", "order", "cycleUse", "subscription", "payslip", "expense", "auditLog", "otp", "pushSubscription", "fySequence", "student", "staff", "college", "appConfig"] as const;
  for (const t of tables) await (db as any)[t].deleteMany({});

  const c1 = await db.college.create({ data: { name: "St Mary's", address: "Main Campus, College Road", active: true, features: { ...DEFAULT_FEATURES, express: true } } });
  const c2 = await db.college.create({ data: { name: "BVRIT", address: "Vishnupur, Narsapur", active: true, features: { ...DEFAULT_FEATURES, express: true } } });

  const students = [
    { id: "482913", phone: "9876500011", name: "Aarav Menon", collegeId: c1.id, credits: 250, lifetimePieces: 186, createdAt: new Date(t0 - 90 * DAY) },
    { id: "517204", phone: "9876500022", name: "Diya Sharma", collegeId: c1.id, credits: 0, lifetimePieces: 42, createdAt: new Date(t0 - 30 * DAY) },
    { id: "690145", phone: "9876500033", name: "Kabir Rao", collegeId: c2.id, credits: 120, lifetimePieces: 73, createdAt: new Date(t0 - 50 * DAY) },
    { id: "238876", phone: "9876500044", name: "Ishita Nair", collegeId: c2.id, credits: 0, lifetimePieces: 9, createdAt: new Date(t0 - 8 * DAY) },
    /* The owner's own number, ALSO a student. Staff and Student are separate
       tables with separate unique constraints, so one number can hold both —
       and it must, because the owner tests the customer app on the same phone
       they run the counter from. Seeded here so `npm run seed` reproduces it;
       before this, signing in on the Customer tab with the documented owner
       number said "not registered", which read as a bug and was really just
       missing data. */
    { id: "801966", phone: "8019121966", name: "Owner (customer)", collegeId: c1.id, credits: 0, lifetimePieces: 0, createdAt: new Date(t0 - 5 * DAY) },
  ];
  for (const s of students) await db.student.create({ data: s });

  // Aarav's active subscription with dated cycle log
  const sub = await db.subscription.create({
    data: {
      studentId: "482913", active: true, plan: "Annual Plan",
      startedAt: new Date(t0 - 40 * DAY), expiresAt: new Date(t0 + 325 * DAY),
      cyclesTotal: 34, cyclesUsed: 12, kgPerCycle: 7,
    },
  });
  const span = 40 * DAY;
  for (let i = 0; i < 12; i++) {
    await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: "", at: new Date(Math.round(t0 - 40 * DAY + (span * (i + 0.5)) / 12) ) } });
  }

  await db.staff.createMany({
    data: [
      { phone: "8019121966", name: "Owner", role: 4, collegeId: c1.id },
      { phone: "9000000002", name: "Rhea (Admin)", role: 3, collegeId: c1.id },
      { phone: "9000000003", name: "Sanjay (Manager)", role: 2, collegeId: c1.id },
      { phone: "9000000004", name: "Priya (Counter)", role: 1, collegeId: c1.id },
    ],
  });
  const manager = await db.staff.findFirstOrThrow({ where: { role: 2 } });
  const admin = await db.staff.findFirstOrThrow({ where: { role: 3 } });

  type Svc = keyof typeof DEFAULT_RATES;
  async function mkOrder(stu: (typeof students)[number], service: Svc, pieces: [string, number][], status: string, express: boolean, ageDays: number) {
    const rate = DEFAULT_RATES[service];
    const items = pieces.map(([label, qty]) => {
      const found = (rate.items as unknown as [string, number][]).find((r) => r[0] === label) || (rate.items[0] as unknown as [string, number]);
      return { label: found[0], rate: found[1], qty };
    });
    const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
    const surcharge = express ? Math.round(sub * EXPRESS_PCT) : 0;
    const gstAmt = Math.round((sub + surcharge) * 0.18);
    const total = sub + surcharge + gstAmt;
    const created = t0 - ageDays * DAY;
    const chain = ["received", "processing", "ready", "collected"];
    const upto = chain.indexOf(status);
    const totalQty = items.reduce((s, i) => s + i.qty, 0);
    const o = await db.order.create({
      data: {
        id: orderCode(), studentId: stu.id, collegeId: stu.collegeId, service,
        items, declaredPieces: totalQty,
        actualPieces: status === "draft" ? null : totalQty,
        weightKg: status === "draft" ? null : Math.max(1, Math.round(totalQty / 3)),
        express, surcharge, status,
        subtotal: sub, gst: gstAmt, gstPctSnapshot: 18, total,
        paid: status === "collected", paymentMethod: status === "collected" ? "upi" : null,
        usedCycle: false, createdAt: new Date(created),
        receivedAt: upto >= 0 ? new Date(created + 4 * HOUR) : null,
      },
    });
    await db.orderEvent.create({ data: { orderId: o.id, status: "placed", at: new Date(created) } });
    for (let i = 0; i <= upto; i++) {
      await db.orderEvent.create({ data: { orderId: o.id, status: chain[i], at: new Date(created + (i + 1) * 4 * HOUR) } });
    }
    return o;
  }

  const orders = [
    await mkOrder(students[0], "washIron", [["Regular garment", 9]], "processing", false, 1),
    await mkOrder(students[0], "dryClean", [["Shirt / Pant / T-shirt", 3], ["Ladies' top", 1]], "ready", false, 2),
    await mkOrder(students[1], "ironOnly", [["Shirt / T-shirt / Pant", 6], ["Saree", 1]], "received", false, 0),
    await mkOrder(students[1], "washIron", [["Regular garment", 5]], "draft", false, 0),
    await mkOrder(students[2], "dryClean", [["Shoes / Sneakers", 1], ["Shirt / Pant / T-shirt", 2]], "collected", true, 5),
    await mkOrder(students[2], "washIron", [["Regular garment", 7]], "collected", false, 9),
    await mkOrder(students[3], "ironOnly", [["Shirt / T-shirt / Pant", 4]], "ready", false, 1),
  ];

  await db.compensation.create({
    data: { studentId: students[0].id, orderId: orders[1].id, kind: "damage", amount: 150, comment: "Button chipped on blue shirt — issued credits.", by: manager.id, method: "credit", at: new Date(t0 - 2 * DAY) },
  });

  const cpl = await db.complaint.create({
    data: { studentId: students[2].id, collegeId: c2.id, text: "One sock missing from my last wash order.", status: "open", at: new Date(t0 - 1 * DAY), orderId: orders[4].id },
  });
  await db.complaintMessage.create({ data: { complaintId: cpl.id, from: "student", by: students[2].id, text: "One sock missing from my last wash order.", at: new Date(t0 - 1 * DAY) } });

  await db.notification.createMany({
    data: [
      { studentId: students[0].id, text: "Your dry clean order is ready for collection.", at: new Date(t0 - 4 * HOUR), read: false, kind: "ready" },
      { studentId: students[0].id, text: "Order received — 9 pieces logged for Wash & Iron.", at: new Date(t0 - 1 * DAY), read: true, kind: "status" },
    ],
  });

  await db.creditUse.create({ data: { studentId: students[0].id, orderId: "", amount: 80, at: new Date(t0 - 15 * DAY) } });

  await db.invoice.create({
    data: { number: "INV-1001", orderId: orders[4].id, studentId: students[2].id, collegeId: c2.id, subtotal: Number(orders[4].subtotal) + Number(orders[4].surcharge), gst: orders[4].gst, gstPct: 18, total: orders[4].total, method: "upi", at: new Date(t0 - 5 * DAY) },
  });
  await db.invoice.create({
    data: { number: "INV-1002", orderId: orders[5].id, studentId: students[2].id, collegeId: c2.id, subtotal: orders[5].subtotal, gst: orders[5].gst, gstPct: 18, total: orders[5].total, method: "upi", at: new Date(t0 - 9 * DAY) },
  });

  await db.expense.createMany({
    data: [
      { category: "Supplies", amount: 1200, note: "Detergent & starch restock", method: "cash", by: admin.id, collegeId: c1.id, at: new Date(t0 - 1 * DAY) },
      { category: "Utilities", amount: 2400, note: "Electricity", method: "upi", by: admin.id, collegeId: c1.id, at: new Date(t0 - 3 * DAY) },
    ],
  });

  await db.payment.createMany({
    data: [
      { method: "upi", amount: orders[4].total, at: new Date(t0 - 5 * DAY), orderId: orders[4].id, collegeId: c2.id, studentId: students[2].id },
      { method: "upi", amount: orders[5].total, at: new Date(t0 - 9 * DAY), orderId: orders[5].id, collegeId: c2.id, studentId: students[2].id },
      { method: "cash", amount: 820, at: new Date(t0), collegeId: c1.id, note: "Counter walk-in" },
      { method: "upi", amount: 540, at: new Date(t0), collegeId: c1.id, note: "Iron only" },
      { method: "credit", amount: 120, at: new Date(t0), collegeId: c1.id, note: "Redeemed credits" },
    ],
  });

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: JSON.parse(JSON.stringify(DEFAULT_RATES)),
      payment: { upiId: "fabricfold@okicici", payeeName: "FabricFold Laundry", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });

  console.log("Seed complete:", { colleges: 2, students: students.length, orders: orders.length });
}

main().finally(() => db.$disconnect());
