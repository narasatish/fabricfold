/* Load test: simulate ~1000 concurrent users against a REAL running instance
   of the app, on the current Supabase Free-tier project, to get an honest
   answer to "does it hold up at scale" instead of a guess.

   Safety, same pattern as e2e-check.ts: NEVER touches the live `public`
   schema. Forces the isolated `ff_test` schema, tags every row it creates,
   and deletes them again at the end — production data is never read or
   written. Run only when there's no real traffic to disturb (owner confirmed
   no live users yet, Sep 2026).

   Run:  npx tsx scripts/load-test.ts [concurrentUsers] [requestsPerUser] */
import "dotenv/config";
import { SignJWT } from "jose";
import { spawn, ChildProcess } from "node:child_process";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
if (!/^postgres(ql)?:\/\//.test(BASE)) {
  console.error("Refusing to run: need a Postgres DATABASE_URL/DIRECT_URL.");
  process.exit(1);
}
const TEST_URL = BASE.split("?")[0] + "?schema=ff_test";
process.env.DATABASE_URL = TEST_URL;

const TAG = "loadtest";
const PORT = 3099;
const ORIGIN = `http://localhost:${PORT}`;
const N_USERS = Number(process.argv[2]) || 1000;
const REQS_PER_USER = Number(process.argv[3]) || 1;
const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret");

async function mintCookie(studentId: string) {
  const jwt = await new SignJWT({ mode: "customer", studentId, epoch: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(SECRET);
  return `ff_session=${jwt}`;
}

async function seed(db: typeof import("../lib/db").db) {
  console.log(`Seeding ${N_USERS} synthetic students in the isolated ff_test schema…`);
  await cleanup(db); // clear any previous aborted run

  // Real pages read appConfig; ff_test may not have it seeded on a fresh push.
  await db.appConfig.upsert({
    where: { id: "main" },
    update: {},
    create: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washFold: { label: "Wash & Fold", items: [["Regular garment", 12]] } },
      payment: {}, settings: {},
    },
  });

  const college = await db.college.create({
    data: { id: TAG + "col", name: "Load Test Campus", features: {} },
  });

  const students: { id: string }[] = [];
  const BATCH = 200;
  for (let i = 0; i < N_USERS; i += BATCH) {
    const chunk = Array.from({ length: Math.min(BATCH, N_USERS - i) }, (_, j) => {
      const n = i + j;
      return {
        id: `${TAG}${n}`,
        phone: `9${String(9000000 + n).padStart(9, "0")}`.slice(0, 10),
        name: `Load Test Student ${n}`,
        collegeId: college.id,
      };
    });
    await db.student.createMany({ data: chunk });
    students.push(...chunk.map((c) => ({ id: c.id })));
  }

  // A realistic mix of orders so pages aren't rendering empty states.
  const statuses = ["received", "processing", "ready", "collected"];
  const orderData = students.slice(0, Math.min(N_USERS, 500)).map((s, i) => ({
    id: `${TAG}ord${i}`,
    studentId: s.id,
    collegeId: college.id,
    status: statuses[i % statuses.length],
    service: "washFold",
    declaredPieces: 8,
    items: [],
    subtotal: 200,
    gst: 0,
    gstPctSnapshot: 0,
    total: 200,
    receivedAt: new Date(),
  }));
  if (orderData.length) await db.order.createMany({ data: orderData });

  console.log(`Seeded ${students.length} students, ${orderData.length} orders.`);
  return students;
}

async function cleanup(db: typeof import("../lib/db").db) {
  const students = await db.student.findMany({ where: { id: { startsWith: TAG } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  if (ids.length) {
    await db.order.deleteMany({ where: { studentId: { in: ids } } });
    await db.notification.deleteMany({ where: { studentId: { in: ids } } });
    await db.student.deleteMany({ where: { id: { in: ids } } });
  }
  await db.college.deleteMany({ where: { id: { startsWith: TAG } } });
}

function waitForServer(proc: ChildProcess, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start in time")), timeoutMs);
    const onData = (d: Buffer) => {
      const s = d.toString();
      process.stdout.write(`[server] ${s}`);
      if (/ready|started server/i.test(s)) {
        clearTimeout(t);
        proc.stdout?.off("data", onData);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (d) => process.stdout.write(`[server:err] ${d}`));
  });
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function fireRequests(cookies: string[]) {
  const paths = ["/c", "/c/orders"];
  const latencies: number[] = [];
  let errors = 0;
  let statusCounts: Record<number, number> = {};

  const CONCURRENCY = 100; // bounded batches, not one giant Promise.all
  let cursor = 0;
  const jobs: { cookie: string; path: string }[] = [];
  for (const cookie of cookies) {
    for (let r = 0; r < REQS_PER_USER; r++) {
      jobs.push({ cookie, path: paths[jobs.length % paths.length] });
    }
  }

  console.log(`Firing ${jobs.length} authenticated requests, ${CONCURRENCY} at a time…`);
  const start = Date.now();

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const t0 = Date.now();
      try {
        const res = await fetch(ORIGIN + job.path, { headers: { Cookie: job.cookie }, redirect: "manual" });
        latencies.push(Date.now() - t0);
        statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
        if (res.status >= 500) errors++;
      } catch {
        errors++;
        latencies.push(Date.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const totalMs = Date.now() - start;
  latencies.sort((a, b) => a - b);

  return { totalMs, count: jobs.length, errors, statusCounts, latencies };
}

async function main() {
  console.log(`\nFabricFold load test — ${N_USERS} simulated users, isolated ff_test schema\n`);
  const { db } = await import("../lib/db");

  const students = await seed(db);
  const cookies = await Promise.all(students.map((s) => mintCookie(s.id)));

  console.log(`\nBuilding + starting a production server on port ${PORT} against ff_test…`);
  const proc = spawn("npx", ["next", "start", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_URL: TEST_URL },
    shell: true,
  });
  proc.on("error", (e) => console.error("server spawn error", e));

  try {
    await waitForServer(proc);
    await new Promise((r) => setTimeout(r, 1000)); // small settle margin

    const result = await fireRequests(cookies);

    console.log("\n─── Results ───────────────────────────────");
    console.log(`Requests:        ${result.count}`);
    console.log(`Wall time:        ${(result.totalMs / 1000).toFixed(1)}s`);
    console.log(`Throughput:       ${(result.count / (result.totalMs / 1000)).toFixed(1)} req/s`);
    console.log(`Errors (5xx/net): ${result.errors} (${((result.errors / result.count) * 100).toFixed(2)}%)`);
    console.log(`Status codes:     ${JSON.stringify(result.statusCounts)}`);
    console.log(`Latency p50:      ${percentile(result.latencies, 50)}ms`);
    console.log(`Latency p95:      ${percentile(result.latencies, 95)}ms`);
    console.log(`Latency p99:      ${percentile(result.latencies, 99)}ms`);
    console.log(`Latency max:      ${result.latencies[result.latencies.length - 1]}ms`);
    console.log("────────────────────────────────────────────\n");
  } finally {
    proc.kill();
    console.log("Cleaning up test data from ff_test schema…");
    await cleanup(db);
    console.log("Done.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
