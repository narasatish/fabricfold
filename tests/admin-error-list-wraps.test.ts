/* Found in the Sep 21 QA pass at 320px wide: the Admin "App errors" lines held
   long unbroken text (error messages full of file paths / URLs) that did not
   wrap, so on a phone it ran off the screen and was cut. Text that can be long
   and unbroken must be allowed to break anywhere. */
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

it("the error-list message cell can shrink and break long words", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "app/s/admin/_components/AdminClient.tsx"), "utf8");
  const i = src.indexOf("errors.slice(0, 8).map");
  const block = src.slice(i, i + 900);
  expect(block).toMatch(/minWidth: 0/);
  expect(block).toMatch(/overflowWrap: "anywhere"/);
});
