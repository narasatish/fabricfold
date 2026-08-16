/* Orders captured while the counter had no connection.

   The thing that must never happen is a student's bag being booked in twice
   because a replay fired more than once — or, worse, not at all because the
   queue quietly dropped it. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  enqueueIntake, listQueued, queueCount, dequeueIntake,
  markIntakeError, replayQueue, newIdemKey, type QueuedIntake,
} from "../lib/offline-queue";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

/** localStorage does not exist in the node test env. */
function fakeStorage() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    key: () => null, length: 0,
  } as unknown as Storage;
}

const intake = (studentId: string): Omit<QueuedIntake, "idemKey" | "capturedAt"> => ({
  studentId,
  studentLabel: "Test Student",
  service: "washIron",
  items: [{ label: "Regular garment", qty: 3 }],
  weightKg: null,
  useCycle: false,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
});

describe("capture survives a reload", () => {
  it("stores an intake and reads it back", () => {
    enqueueIntake(intake("s1"));
    expect(queueCount()).toBe(1);
    expect(listQueued()[0].studentId).toBe("s1");
  });

  it("gives every intake a unique key", () => {
    const keys = new Set([newIdemKey(), newIdemKey(), newIdemKey()]);
    expect(keys.size).toBe(3);
  });

  it("returns oldest first — the first bag handed over is booked in first", () => {
    const a = enqueueIntake(intake("first"));
    vi.setSystemTime(new Date(Date.now() + 1000));
    const b = enqueueIntake(intake("second"));
    const order = listQueued().map((r) => r.idemKey);
    expect(order).toEqual([a.idemKey, b.idemKey]);
    vi.useRealTimers();
  });

  it("survives corrupt storage instead of taking the counter down", () => {
    localStorage.setItem("ff.offline.intakes", "{not json");
    expect(listQueued()).toEqual([]);
    // and still accepts new work
    enqueueIntake(intake("s1"));
    expect(queueCount()).toBe(1);
  });
});

describe("replay", () => {
  it("removes an intake ONLY after the server confirms it", async () => {
    enqueueIntake(intake("s1"));
    const r = await replayQueue(async () => ({ ok: true, id: "FF1" }));
    expect(r.sent).toBe(1);
    expect(queueCount()).toBe(0);
  });

  it("keeps it queued when the server says no", async () => {
    enqueueIntake(intake("s1"));
    const r = await replayQueue(async () => ({ ok: false, error: "boom" }));
    expect(r.failed).toBe(1);
    expect(queueCount()).toBe(1); // still there to try again
    expect(listQueued()[0].lastError).toBe("boom");
  });

  it("keeps it queued when submit THROWS, not just when it returns false", async () => {
    // a dead connection rejects rather than resolving
    enqueueIntake(intake("s1"));
    const r = await replayQueue(async () => { throw new Error("network down"); });
    expect(r.failed).toBe(1);
    expect(queueCount()).toBe(1);
  });

  it("stops at the first failure rather than hammering a flaky link", async () => {
    enqueueIntake(intake("a"));
    enqueueIntake(intake("b"));
    enqueueIntake(intake("c"));
    let calls = 0;
    await replayQueue(async () => { calls++; return { ok: false, error: "still offline" }; });
    expect(calls).toBe(1);
    expect(queueCount()).toBe(3);
  });

  it("sends each queued order exactly once", async () => {
    enqueueIntake(intake("a"));
    enqueueIntake(intake("b"));
    const seen: string[] = [];
    await replayQueue(async (row) => { seen.push(row.idemKey); return { ok: true }; });
    expect(seen.length).toBe(2);
    expect(new Set(seen).size).toBe(2);
    expect(queueCount()).toBe(0);
  });

  it("carries the SAME key on a retry, so the server can recognise it", async () => {
    const row = enqueueIntake(intake("s1"));
    const keys: string[] = [];
    await replayQueue(async (r) => { keys.push(r.idemKey); return { ok: false, error: "x" }; });
    await replayQueue(async (r) => { keys.push(r.idemKey); return { ok: true }; });
    expect(keys).toEqual([row.idemKey, row.idemKey]);
  });
});

describe("bookkeeping", () => {
  it("dequeues only the named intake", () => {
    const a = enqueueIntake(intake("a"));
    enqueueIntake(intake("b"));
    dequeueIntake(a.idemKey);
    expect(listQueued().map((r) => r.studentId)).toEqual(["b"]);
  });

  it("truncates a long error rather than filling storage with a stack trace", () => {
    const a = enqueueIntake(intake("a"));
    markIntakeError(a.idemKey, "x".repeat(1000));
    expect(listQueued()[0].lastError!.length).toBeLessThanOrEqual(200);
  });
});

describe("the server refuses a duplicate replay", () => {
  const orders = read("lib/actions/orders.ts");
  const guards = read("scripts/ensure-guards.mjs");

  it("a known key returns the existing order instead of creating another", () => {
    expect(orders).toMatch(/if \(input\.idemKey\) \{[\s\S]{0,220}?return \{ ok: true as const, id: already\.id, replayed: true \}/);
  });

  it("two replays racing each other still yield one order", () => {
    // the lookup finds nothing for both, then the index rejects the loser
    expect(orders).toMatch(/code === "P2002" && input\.idemKey/);
  });

  it("the database enforces it, not just the lookup", () => {
    expect(guards).toMatch(/order_idem_key_uniq/);
    expect(guards).toMatch(/\("idemKey"\) WHERE "idemKey" IS NOT NULL/);
  });
});

describe("the counter is told what is happening", () => {
  const ui = read("components/offline.tsx");
  const customer = read("app/s/customers/[id]/_components/CustomerClient.tsx");

  it("assumes ONLINE until proven otherwise", () => {
    // a wrong "offline" on first paint would scare staff on every page load
    expect(ui).toMatch(/useState\(true\)/);
  });

  it("queues instead of calling when already offline", () => {
    expect(customer).toMatch(/!navigator\.onLine/);
    expect(customer).toMatch(/enqueueIntake\(intake\)/);
  });

  it("queues when the call THROWS mid-flight, since the server may have committed", () => {
    expect(customer).toMatch(/enqueueIntake\(\{ \.\.\.intake, idemKey \}\)/);
  });

  it("retries automatically when the connection returns", () => {
    expect(ui).toMatch(/if \(online && queued\.length && !busy\) void send\(\)/);
  });
});
