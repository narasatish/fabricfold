/* BVRIT and St Mary's are separate businesses. Proves, on a real isolated
   schema: (1) each college can close its own cash drawer for the same date,
   while a second close for the SAME college is still rejected; (2) the
   per-college reporting views (v_by_college_*) filter cleanly by collegeName,
   including tables that only reach a college through the student. */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_college_split";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
let client: import("pg").Client;
const rows = async (sql: string, p: unknown[] = []) => (await client.query(sql, p)).rows;

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  const cwd = path.resolve(__dirname, "..");
  const env = { ...process.env, DATABASE_URL: TEST_URL, DIRECT_URL: TEST_URL };
  execSync("npx prisma db push", { cwd, stdio: "ignore", env });
  execSync("node scripts/ensure-guards.mjs", { cwd, stdio: "ignore", env: { ...env, FF_GUARD_SCHEMA: SCHEMA } });
  client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`set search_path to "${SCHEMA}"`);
  await client.query(`insert into "College" (id,name,features,active,address) values ('bv','BVRIT','{}',true,''),('sm','St Mary''s','{}',true,'')`);
  await client.query(`insert into "Student" (id,phone,name,"collegeId",credits,"lifetimePieces","createdAt","sessionEpoch",kind) values
    ('s_bv','9000000001','BV Kid','bv',0,0,now(),0,'student'),('s_sm','9000000002','SM Kid','sm',0,0,now(),0,'student')`);
  await client.query(`insert into "Notification" (id,"studentId",text,kind,at) values ('n1','s_bv','hi bv','status',now()),('n2','s_sm','hi sm','status',now())`);
  await client.query(`insert into "Payment" (id,method,amount,"at","collegeId","studentId",note) values ('p1','cash',100,now(),'bv','s_bv','x'),('p2','upi',200,now(),'sm','s_sm','y')`);
}, 300_000);

afterAll(async () => { await client?.end(); });

describe("per-college cash drawer", () => {
  const ins = (college: string) => client.query(
    `insert into "DayClose" (id,date,"collegeId","expectedCash","countedCash",variance,by,at) values ($1,'2026-09-21',$2,0,0,0,'x',now())`,
    ["dc_" + college + Math.random(), college]);
  it("both colleges can close the same date", async () => {
    await ins("bv"); await ins("sm");
    expect((await rows(`select count(*)::int n from "DayClose" where date='2026-09-21'`))[0].n).toBe(2);
  });
  it("a second close for the SAME college is rejected", async () => {
    await expect(ins("bv")).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("per-college views", () => {
  it("payments filter by collegeName", async () => {
    const r = await rows(`select id from v_by_college_payment where "collegeName" = 'BVRIT'`);
    expect(r.map((x) => x.id)).toEqual(["p1"]);
  });
  it("notifications (student-linked table) filter by collegeName", async () => {
    const r = await rows(`select id from v_by_college_notification where "collegeName" = 'St Mary''s'`);
    expect(r.map((x) => x.id)).toEqual(["n2"]);
  });
  it("students filter by collegeName", async () => {
    const r = await rows(`select name from v_by_college_student where "collegeName" = 'BVRIT'`);
    expect(r.map((x) => x.name)).toEqual(["BV Kid"]);
  });
});
