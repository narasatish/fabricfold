/* Admin config writes (price lists, GST, UPI/bank details, report email) had no
   validation, unlike the Sheet's Config tab which enforces GST 0-28 and prices
   >0 up to 100000. Found in the Sep 21 testing pass. A negative or NaN price
   makes every order at that college fail (the DB refuses a negative total); a
   mistyped UPI ID sends students' money to the wrong account. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ratesProblem, expressProblem, gstProblem, paymentProblem, emailProblem } from "../lib/config-validation";

const ok = { washFold: { label: "Wash & Fold", items: [["Regular garment", 15]] } };

describe("ratesProblem", () => {
  it("accepts a normal price list", () => expect(ratesProblem(ok)).toBeNull());
  it("rejects bad prices", () => {
    for (const p of [0, -5, NaN, Infinity, 100001, "15" as unknown as number]) {
      expect(ratesProblem({ washFold: { label: "x", items: [["Shirt", p]] } }), String(p)).toMatch(/price/i);
    }
  });
  it("rejects bad shapes and over-long text", () => {
    expect(ratesProblem(null as never)).toBeTruthy();
    expect(ratesProblem({ washFold: { label: "x", items: "no" } } as never)).toBeTruthy();
    expect(ratesProblem({ washFold: { label: "x", items: [["", 10]] } })).toBeTruthy();
    expect(ratesProblem({ washFold: { label: "x", items: [["y".repeat(200), 10]] } })).toBeTruthy();
    expect(ratesProblem({ washFold: { label: "L".repeat(200), items: [["a", 10]] } })).toBeTruthy();
  });
});

describe("expressProblem / gstProblem", () => {
  it("express fees: finite, 0-10000", () => {
    expect(expressProblem({ washFold: 80 })).toBeNull();
    for (const v of [NaN, -1, Infinity, 10001]) expect(expressProblem({ washFold: v })).toBeTruthy();
  });
  it("GST 0-28 and finite", () => {
    expect(gstProblem(18)).toBeNull();
    for (const g of [NaN, -1, 29, Infinity]) expect(gstProblem(g)).toBeTruthy();
  });
});

describe("paymentProblem", () => {
  const good = { upiId: "fabricfold@centralbank", payeeName: "FabricFold", bankName: "Central Bank of India", accountName: "FabricFold", accountNo: "1234567890", ifsc: "CBIN0281234", gatewayKey: "" };
  it("accepts good details and an unset UPI ID", () => {
    expect(paymentProblem(good)).toBeNull();
    expect(paymentProblem({ ...good, upiId: "", accountNo: "", ifsc: "" })).toBeNull();
  });
  it("a FIRST save with only a UPI ID typed works (production's payment object starts empty)", () => {
    expect(paymentProblem({ upiId: "fabricfold@centralbank" })).toBeNull();
    expect(paymentProblem({})).toBeNull();
  });
  it("rejects a non-text field", () => expect(paymentProblem({ ...good, ifsc: 5 as never })).toBeTruthy());
  it("rejects a malformed UPI ID (the QR is built from it)", () => {
    for (const u of ["fabricfold", "fabric fold@bank", "@bank", "a@b", "x@@y", "a@bank; drop", "https://evil.com/pay"]) {
      expect(paymentProblem({ ...good, upiId: u }), u).toMatch(/UPI/);
    }
  });
  it("rejects a malformed IFSC or account number", () => {
    expect(paymentProblem({ ...good, ifsc: "BAD" })).toMatch(/IFSC/);
    expect(paymentProblem({ ...good, accountNo: "12ab" })).toMatch(/account/i);
  });
});

describe("emailProblem", () => {
  it("empty is allowed; malformed is not", () => {
    expect(emailProblem("")).toBeNull();
    expect(emailProblem("owner@example.com")).toBeNull();
    for (const e of ["nope", "a@b", "a b@c.com", "x".repeat(300) + "@a.com"]) expect(emailProblem(e), e).toBeTruthy();
  });
});

describe("the actions use them before writing", () => {
  const admin = fs.readFileSync(path.resolve(__dirname, "..", "lib/actions/admin.ts"), "utf8");
  const body = (n: string) => { const i = admin.indexOf(`export async function ${n}`); return admin.slice(i, admin.indexOf("\n}\n", i)); };
  const cases: [string, string, string][] = [
    ["saveRates", "ratesProblem(", "db.appConfig.update"], ["saveRates", "gstProblem(", "db.appConfig.update"],
    ["saveCollegeRates", "ratesProblem(", "db.college.update"], ["saveCollegeExpressRates", "expressProblem(", "db.college.update"],
    ["savePaymentConfig", "paymentProblem(", "db.appConfig.update"],
  ];
  for (const [fn, guard, write] of cases) {
    it(`${fn} calls ${guard} before ${write}`, () => {
      const b = body(fn);
      expect(b).toContain(guard);
      expect(b.indexOf(guard)).toBeLessThan(b.indexOf(write));
    });
  }
  it("saveSettings validates reportEmail", () => expect(body("saveSettings")).toContain("emailProblem("));
});
