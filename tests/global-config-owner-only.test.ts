/* Found in the live-site testing pass (Sep 21): saveRates, savePaymentConfig
   and saveSettings write BUSINESS-WIDE config — the default price list St
   Mary's uses, GST, the UPI/bank details every college's students pay to, the
   report email. They only required role 3 (Admin), so a campus-scoped Admin
   (role 3 with a collegeId — e.g. BVRIT's) could reprice St Mary's or repoint
   the UPI ID. Per-college settings already check assertSameCollege; these
   three had nothing. They now require an account with NO campus scope. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { assertGlobalScope, AuthError } from "../lib/auth";

const admin = fs.readFileSync(path.resolve(__dirname, "..", "lib/actions/admin.ts"), "utf8");
const bodyOf = (fn: string) => {
  const i = admin.indexOf(`export async function ${fn}`);
  return admin.slice(i, admin.indexOf("\n}\n", i));
};

describe("assertGlobalScope", () => {
  it("refuses a campus-scoped account", () => {
    expect(() => assertGlobalScope({ collegeId: "bvrit" })).toThrow(AuthError);
  });
  it("lets an account with no campus (owner-level) through", () => {
    expect(() => assertGlobalScope({ collegeId: null })).not.toThrow();
  });
});

describe("business-wide config actions are guarded", () => {
  for (const fn of ["saveRates", "savePaymentConfig", "saveSettings"]) {
    it(`${fn} calls assertGlobalScope before writing`, () => {
      const body = bodyOf(fn);
      expect(body).toMatch(/assertGlobalScope\(st\)/);
      expect(body.indexOf("assertGlobalScope")).toBeLessThan(body.indexOf("db.appConfig.update"));
    });
  }
});
