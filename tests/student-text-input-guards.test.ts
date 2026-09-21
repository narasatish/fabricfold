/* Student-typed input. Found in the Sep 21 testing pass: rateOrder turned a
   NaN or fractional rating into a database error (Int column), and neither
   rateOrder's comment nor submitComplaint's text had any length limit. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
const body = (src: string, name: string) => { const i = src.indexOf(`export async function ${name}`); return src.slice(i, src.indexOf("\nexport async function ", i + 10)); };

describe("student text/number input", () => {
  it("rateOrder refuses a non-integer rating instead of crashing the write", () => {
    const b = body(read("lib/actions/orders.ts"), "rateOrder");
    expect(b).toMatch(/Number\.isInteger\(rating\)/);
    expect(b.indexOf("Number.isInteger(rating)")).toBeLessThan(b.indexOf("db.order.update"));
  });
  it("rateOrder caps the comment length", () => {
    expect(body(read("lib/actions/orders.ts"), "rateOrder")).toMatch(/comment.*\.slice\(0, 500\)|MAX_COMMENT/);
  });
  it("submitComplaint caps the text length", () => {
    expect(body(read("lib/actions/complaints.ts"), "submitComplaint")).toMatch(/t\.length > 2000|\.slice\(0, 2000\)/);
  });
});
