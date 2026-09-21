/* Online payment (Razorpay: UPI / card / netbanking) is allowed per college:
   BVRIT everyone, St Mary's faculty only. Two flags, both OFF by default, so
   setting the Razorpay keys alone changes nothing until a college is switched
   on. Enforced in the server actions, not just by hiding a button. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { onlinePaymentAllowed } from "../lib/features";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("onlinePaymentAllowed", () => {
  it("is OFF by default for everyone (keys alone enable nothing)", () => {
    expect(onlinePaymentAllowed({}, "student")).toBe(false);
    expect(onlinePaymentAllowed({}, "faculty")).toBe(false);
    expect(onlinePaymentAllowed(null, "student")).toBe(false);
  });
  it("gateway:true opens it to every student AND faculty of that college (BVRIT)", () => {
    expect(onlinePaymentAllowed({ gateway: true }, "student")).toBe(true);
    expect(onlinePaymentAllowed({ gateway: true }, "faculty")).toBe(true);
  });
  it("gatewayFaculty:true opens it to faculty only (St Mary's)", () => {
    expect(onlinePaymentAllowed({ gatewayFaculty: true }, "faculty")).toBe(true);
    expect(onlinePaymentAllowed({ gatewayFaculty: true }, "student")).toBe(false);
  });
  it("an explicit false or junk value never enables it", () => {
    expect(onlinePaymentAllowed({ gateway: false, gatewayFaculty: false }, "faculty")).toBe(false);
    expect(onlinePaymentAllowed({ gateway: "yes" }, "student")).toBe(false);
  });
});

describe("enforced server-side, not only in the UI", () => {
  const pay = read("lib/actions/payments.ts");
  it("createGatewayOrder and confirmGatewayPayment both check it", () => {
    for (const fn of ["createGatewayOrder", "confirmGatewayPayment"]) {
      const i = pay.indexOf(`export async function ${fn}`);
      expect(pay.slice(i, i + 900), fn).toMatch(/onlinePaymentAllowed\(/);
    }
  });
  it("the pay page only offers 'Pay online' when allowed", () => {
    expect(read("app/c/pay/[id]/page.tsx")).toMatch(/onlinePaymentAllowed\(student\.college\.features, student\.kind\)/);
  });
  it("the admin can toggle both flags", () => {
    const admin = read("app/s/admin/_components/AdminClient.tsx");
    expect(admin).toContain('"gateway"');
    expect(admin).toContain('"gatewayFaculty"');
  });
});
