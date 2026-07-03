/* Quick e2e verification helper: node scripts via `npx tsx scripts/check-invoice.ts <orderId>` */
import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../lib/generated/prisma/client";

const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || "file:./dev.db" }) });

async function main() {
  const orderId = process.argv[2] || "FF813208";
  const inv = await db.invoice.findUnique({ where: { orderId } });
  const pays = await db.payment.findMany({ where: { orderId } });
  const o = await db.order.findUnique({ where: { id: orderId } });
  console.log("order:", o ? `${o.status} paid=${o.paid} method=${o.paymentMethod} total=${o.total}` : "NONE");
  console.log("invoice:", inv ? `${inv.number} subtotal=${inv.subtotal} gst=${inv.gst} total=${inv.total} method=${inv.method}` : "NONE");
  console.log("payments:", pays.map((p) => p.method + ":" + p.amount).join(", ") || "none");
}
main().finally(() => db.$disconnect());
