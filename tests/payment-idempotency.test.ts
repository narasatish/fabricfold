/* No order may be paid twice.

   This is the one failure on the whole system that costs a student real money
   and cannot be undone: Payment rows are immutable by trigger, so a duplicate
   charge can only be offset with a manual credit note after the fact.

   Both application paths check `paid` before writing and NEITHER check can win
   a race — Postgres runs READ COMMITTED, so two concurrent callers both read
   false. The guarantee therefore lives in the database, and these tests pin
   both the constraint and the code that has to cope with it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const guards = read("scripts/ensure-guards.mjs");
const webhook = read("app/api/razorpay/webhook/route.ts");
const orders = read("lib/actions/orders.ts");

describe("the database refuses a duplicate", () => {
  it("one Razorpay payment id may exist once", () => {
    // this is what makes webhook retries safe
    expect(guards).toMatch(/payment_gateway_ref_uniq/);
    expect(guards).toMatch(/\("gatewayRef"\) WHERE "gatewayRef" IS NOT NULL/);
  });

  it("one order may not hold two payments of the same method", () => {
    expect(guards).toMatch(/payment_order_method_uniq/);
    expect(guards).toMatch(/\("orderId", method\)/);
  });

  it("still allows the credit + UPI split payCore writes", () => {
    // an order part-paid from the wallet has TWO rows, of different methods
    const idx = guards.slice(guards.indexOf("payment_order_method_uniq"));
    expect(idx).toMatch(/method NOT IN \('refund','cash_out'\)/);
  });

  it("reports existing duplicates rather than failing the deploy", () => {
    expect(guards).toMatch(/index NOT added, investigate before real money flows/);
  });
});

describe("the webhook survives a retry", () => {
  it("re-reads the order INSIDE the transaction", () => {
    // the outer `o.paid` check is an early exit, not a guarantee
    expect(webhook).toMatch(/const fresh = await tx\.order\.findUniqueOrThrow/);
    expect(webhook).toMatch(/if \(fresh\.paid\) return null/);
  });

  it("answers 200 on a duplicate so Razorpay stops retrying", () => {
    // a 500 here would make the gateway retry the same duplicate forever
    expect(webhook).toMatch(/code === "P2002"/);
    expect(webhook).toMatch(/ok: true, duplicate: true/);
  });

  it("does not swallow other errors", () => {
    // only the uniqueness collision is treated as success
    expect(webhook).toMatch(/throw e;/);
  });
});

describe("a double tap reads as 'already paid'", () => {
  it("payCore turns the constraint error into the normal message", () => {
    expect(orders).toMatch(/if \(\(e as \{ code\?: string \}\)\.code === "P2002"\) throw new Error\("Already paid"\)/);
  });

  it("the sequential check is still there for the common case", () => {
    expect(orders).toMatch(/if \(o\.paid\) throw new Error\("Already paid"\)/);
  });
});

describe("the gateway fixture models reality", () => {
  const gw = read("tests/gateway.test.ts");

  it("uses a distinct payment id per order", () => {
    /* It used to reuse one literal across scenarios, which cannot happen: a
       Razorpay payment id is globally unique. The database now says so, and
       the shared literal would have failed — the fixture was wrong. */
    expect(gw).toMatch(/paymentId = `pay_TEST_\$\{orderId\}`/);
    expect(gw).not.toMatch(/paymentId = "pay_TEST123"/);
  });
});
