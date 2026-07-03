import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../lib/generated/prisma/client";

const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || "file:./dev.db" }) });

async function main() {
  const otp = await db.otp.findFirst({ where: { purpose: "pickup", refId: "FF813208", usedAt: null } });
  console.log("pickup otp:", otp?.code || "NONE");
  const n = await db.notification.findFirst({ where: { studentId: "517204" }, orderBy: { at: "desc" } });
  console.log("latest notif:", n?.text || "NONE");
}
main().finally(() => db.$disconnect());
