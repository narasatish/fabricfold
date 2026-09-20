/* Behavioral test for scripts/cleanup-demo-data.mjs — the pre-launch script that
   removes the seed demo rows from a database. Runs the REAL prisma/seed.ts into
   an isolated schema, adds real look-alike data that must survive, then proves:
   the dry run changes nothing, a ledger-touching apply refuses without
   --include-ledger, and the applied cleanup removes exactly the demo rows.
   (The ledger-immutability triggers live on the public schema only, so this
   proves the deletion ORDER and selection rules, not the trigger override.) */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_cleanup_demo";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;

let client: import("pg").Client;
let cleanupDemo: (c: import("pg").Client, o?: { apply?: boolean; includeLedger?: boolean }) => Promise<{ applied: boolean; counts: Record<string, any>; ledgerRows: number; owners: { name: string }[] }>;
const count = async (sql: string, p: unknown[] = []) => Number((await client.query(sql, p)).rows[0].n);

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  const cwd = path.resolve(__dirname, "..");
  const env = { ...process.env, DATABASE_URL: TEST_URL, DIRECT_URL: TEST_URL };
  execSync("npx prisma db push", { cwd, stdio: "ignore", env });
  execSync("npx tsx prisma/seed.ts", { cwd, stdio: "ignore", env });

  client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`set search_path to "${SCHEMA}"`);

  // Real data that must survive: a real student who merely shares a demo NAME,
  // a real payment, and the two real owners.
  const { rows: [col] } = await client.query(`select id from "College" where name = 'St Mary''s'`);
  await client.query(`insert into "Student" (id, phone, name, "collegeId", credits, "lifetimePieces", "createdAt", "sessionEpoch", kind) values ('real001','9999922222','Diya Sharma',$1,0,0,now(),0,'student')`, [col.id]);
  await client.query(`insert into "Payment" (id, method, amount, "at", "collegeId", "studentId", note) values ('realpay1','cash',500,now(),$1,'real001','Real top-up')`, [col.id]);
  await client.query(`insert into "Staff" (id, phone, name, role, active, "sessionEpoch") values ('own_sat','9111111111','Satish',4,true,0),('own_yog','9222222222','Yogesh',4,true,0)`);

  cleanupDemo = (await import("../scripts/cleanup-demo-data.mjs")).cleanupDemo as typeof cleanupDemo;
}, 300_000);

afterAll(async () => { await client?.end(); });

describe("cleanup-demo-data", () => {
  it("dry run finds exactly the seed rows and changes nothing", async () => {
    const before = await count(`select count(*)::int n from "Student"`);
    const r = await cleanupDemo(client, { apply: false });
    expect(r.applied).toBe(false);
    expect(r.counts.students).toBe(4);
    expect(r.counts.staff).toBe(3);
    expect(r.counts.orders).toBe(7);
    expect(r.counts.ledger.invoices).toBe(2);
    expect(await count(`select count(*)::int n from "Student"`)).toBe(before);
  });

  it("refuses to apply when ledger rows are involved and --include-ledger is absent, changing nothing", async () => {
    const before = await count(`select count(*)::int n from "Order"`);
    await expect(cleanupDemo(client, { apply: true })).rejects.toThrow(/ledger/i);
    expect(await count(`select count(*)::int n from "Order"`)).toBe(before);
  });

  it("applies with --include-ledger: demo rows gone, real rows and owners untouched", async () => {
    const r = await cleanupDemo(client, { apply: true, includeLedger: true });
    expect(r.applied).toBe(true);

    expect(await count(`select count(*)::int n from "Student" where phone = any($1)`, [["9876500011", "9876500022", "9876500033", "9876500044"]])).toBe(0);
    expect(await count(`select count(*)::int n from "Staff" where phone = any($1)`, [["9000000002", "9000000003", "9000000004"]])).toBe(0);
    expect(await count(`select count(*)::int n from "Order"`)).toBe(0);
    expect(await count(`select count(*)::int n from "Invoice"`)).toBe(0);
    expect(await count(`select count(*)::int n from "Expense"`)).toBe(0);
    expect(await count(`select count(*)::int n from "Complaint"`)).toBe(0);
    expect(await count(`select count(*)::int n from "Plan" where name = 'Annual Plan'`)).toBe(0);

    // survivors
    expect(await count(`select count(*)::int n from "Student" where id = 'real001'`)).toBe(1); // demo NAME, real phone
    expect(await count(`select count(*)::int n from "Payment" where id = 'realpay1'`)).toBe(1);
    expect(await count(`select count(*)::int n from "Staff" where name in ('Satish','Yogesh','Owner') and role = 4`)).toBe(3);
    expect(await count(`select count(*)::int n from "Student" where name = 'Owner (customer)'`)).toBe(1);
    expect(await count(`select count(*)::int n from "College"`)).toBe(2);
    expect(await count(`select count(*)::int n from "AppConfig"`)).toBe(1);
  });

  it("is idempotent: a second run finds nothing", async () => {
    const r = await cleanupDemo(client, { apply: false });
    expect(r.counts.students).toBe(0);
    expect(r.counts.staff).toBe(0);
    expect(r.ledgerRows).toBe(0);
  });
});
