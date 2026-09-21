/* Found in the Sep 21 QA pass: the partners page shows a phone mock-up with
   "Orders handled 318 / On-time collection 97% / Avg. rating 4.6" under
   "This month · your campus" and nothing says it is an example. There are no such
   results yet; presented to a college as real numbers that is a fabricated claim.
   The figures stay (they illustrate the dashboard) but must be labelled. */
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

it("the partners mock-up says its figures are illustrative", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "app/partners/page.tsx"), "utf8");
  const card = src.slice(src.indexOf('className="label"'), src.indexOf("Avg. rating") + 200);
  expect(card).toMatch(/[Ss]ample|[Ii]llustrative|[Ee]xample/);
  expect(card).not.toMatch(/This month · your campus/);
});
