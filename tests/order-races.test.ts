/* Two concurrent requests hitting the same order — a double-tap on a slow
   connection, or the offline-queue's retry firing while the original request
   is still in flight. Found by a bug-hunt audit (Sep 2026): collectOrder had
   no guard at all, unlike payCore (which relies on a unique index on
   (orderId, method) to turn a double-charge into a collision). Two concurrent
   collectOrder calls would both pass the `status !== "collected"` read and
   both commit — double-counting lifetimePieces and double-writing the
   collection Sheet row, permanently (there's nothing to undo it with). */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const orders = read("lib/actions/orders.ts");
const fn = orders.slice(orders.indexOf("export async function collectOrder"), orders.indexOf("export async function payOrder"));

describe("collectOrder can't double-collect under concurrency", () => {
  it("scopes the status transition itself, not a separate read-then-write check", () => {
    // The guard must live IN the update's where clause, not as a plain
    // `if (o.status === "collected")` before the transaction — that read
    // happens before the transaction starts and two concurrent calls would
    // both pass it under READ COMMITTED.
    expect(fn).toMatch(/tx\.order\.updateMany\(\{ where: \{ id: o\.id, status: "ready" \}, data: \{ status: "collected" \} \}\)/);
  });
  it("checks the affected row count and refuses if nothing actually transitioned", () => {
    expect(fn).toMatch(/if \(updated\.count === 0\) throw new Error\("This order was already collected"\)/);
  });
  it("the throw is caught and turned into the normal { ok: false } shape, not an unhandled rejection", () => {
    expect(fn).toMatch(/catch \(e\) \{[\s\S]*?return \{ ok: false as const, error: \(e as Error\)\.message \};/);
  });
  it("everything else in the transition (pieces, OTP, Sheet event) stays inside the same transaction", () => {
    // If it isn't, a second call that loses the updateMany race could still
    // sneak its own lifetimePieces increment through outside the guard.
    const txBody = fn.slice(fn.indexOf("await db.$transaction"), fn.indexOf("} catch (e)"));
    expect(txBody).toMatch(/tx\.orderEvent\.create/);
    expect(txBody).toMatch(/tx\.student\.update/);
    expect(txBody).toMatch(/enqueueSheetEvent\(tx, "collection"/);
  });
});

describe("subscription writes are locked against concurrent top-ups/assigns/upgrades", () => {
  const subs = read("lib/actions/subscription.ts");

  it("sellCyclePack locks the row and re-reads buckets fresh, not the pre-transaction snapshot", () => {
    const body = subs.slice(subs.indexOf("export async function sellCyclePack"), subs.indexOf("export async function sellCyclePack") + 2500);
    expect(body).toMatch(/await tx\.\$executeRaw`SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE "studentId" = \$\{studentId\} FOR UPDATE`/);
    expect(body).toMatch(/const existing = await tx\.subscription\.findUnique\(\{ where: \{ studentId \} \}\)/);
  });

  it("assignSubscription locks the row and re-checks 'already active' fresh, not the pre-transaction guard alone", () => {
    const body = subs.slice(subs.indexOf("export async function assignSubscription"), subs.indexOf("export async function upgradeSubscription"));
    expect(body).toMatch(/await tx\.\$executeRaw`SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE "studentId" = \$\{studentId\} FOR UPDATE`/);
    expect(body).toMatch(/if \(fresh\?\.active\) throw new Error\("This student already has an active plan"\)/);
    expect(body).toMatch(/catch \(e\) \{[\s\S]*?return \{ ok: false as const, error: \(e as Error\)\.message \};/);
  });

  it("upgradeSubscription locks the row and rebuilds buckets from a fresh read, not `cur` fetched before the transaction", () => {
    const body = subs.slice(subs.indexOf("export async function upgradeSubscription"), subs.indexOf("export async function cancelSubscription"));
    expect(body).toMatch(/await tx\.\$executeRaw`SELECT id FROM \$\{Prisma\.raw\(`\$\{dbSchemaPrefix\}"Subscription"`\)\} WHERE "studentId" = \$\{studentId\} FOR UPDATE`/);
    expect(body).toMatch(/const fresh = await tx\.subscription\.findUniqueOrThrow\(\{ where: \{ studentId \} \}\)/);
    // the bucket rebuild must read from `fresh`, not the outer `cur`
    expect(body).toMatch(/const oldBuckets = \(fresh\.buckets as unknown as Used\[\] \| null\) \|\| \[\]/);
  });
});

describe("refundOrder can't refund more than was actually billed", () => {
  const rfn = orders.slice(orders.indexOf("export async function refundOrder"), orders.indexOf("export async function redoOrder"));

  it("caps against the order total minus whatever's already been refunded", () => {
    // A staff typo (₹5000 instead of ₹500 on a ₹500 order) used to go
    // through with no server-side check at all — refundAmount only ever
    // accumulated, nothing ever compared it back against the total.
    expect(rfn).toMatch(/const refundableNow = \(refunded: number\) => Number\(o\.total\) - refunded/);
    expect(rfn).toMatch(/if \(amount > refundableNow\(Number\(o\.refundAmount \|\| 0\)\)\)/);
  });
  it("refuses cleanly once the order has been refunded in full, rather than going negative", () => {
    expect(rfn).toMatch(/This order has already been fully refunded/);
  });
  it("re-checks the cap against a FRESH, locked read inside the transaction too — not just the pre-transaction snapshot", () => {
    // Found by a deep hand-traced re-audit (Sep 2026): the pre-check alone is
    // a TOCTOU gap — two near-simultaneous refunds could both pass it before
    // either commits. This is the same race class collectOrder was fixed for
    // above, applied to refundOrder.
    expect(rfn).toMatch(/SELECT id FROM \$\{table\} WHERE id = \$\{o\.id\} FOR UPDATE/);
    expect(rfn).toMatch(/const stillRefundable = Number\(fresh\.total\) - Number\(fresh\.refundAmount \|\| 0\)/);
    expect(rfn).toMatch(/if \(amount > stillRefundable\) \{/);
  });
});
