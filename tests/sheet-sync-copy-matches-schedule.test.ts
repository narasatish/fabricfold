/* The Admin screen told the owner the Sheet "auto-syncs daily at 9pm IST" while
   the production cron runs hourly (found in the Sep 21 QA pass). The copy and
   the schedule are checked together so they can't drift apart again. */
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

it("the sheets-sync cron is hourly and the Admin copy says so", () => {
  const yaml = read("render.yaml");
  const block = yaml.slice(yaml.indexOf("name: cron-sheets-sync"));
  expect(block.slice(0, block.indexOf("startCommand"))).toMatch(/schedule: "0 \* \* \* \*"/);
  const admin = read("app/s/admin/_components/AdminClient.tsx");
  expect(admin).toContain("syncs automatically every hour");
  expect(admin).not.toMatch(/daily at 9pm/i);
});
