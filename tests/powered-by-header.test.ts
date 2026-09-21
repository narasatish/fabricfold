/* The x-powered-by header advertises the framework to scanners; it stays off. */
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

it("next.config disables x-powered-by", () => {
  expect(readFileSync(path.resolve(__dirname, "..", "next.config.ts"), "utf8")).toMatch(/poweredByHeader:\s*false/);
});
