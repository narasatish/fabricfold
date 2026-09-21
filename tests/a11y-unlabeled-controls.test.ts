/* Found in the Sep 21 QA pass by auditing every rendered page: icon-only
   controls with no accessible name (a screen reader announces them as blank).
   Switch renders a bare toggle button — 22 call sites, including dark mode and
   every Admin toggle — plus the notifications bell and the order chevron link. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("icon-only controls have accessible names", () => {
  const chrome = read("components/chrome.tsx");
  const sw = chrome.slice(chrome.indexOf("export function Switch"));
  it("Switch takes an explicit label and otherwise names itself from the text beside it", () => {
    expect(sw).toMatch(/label\?: string/);
    expect(sw).toMatch(/aria-label=\{label \?\? auto\}/);
    expect(sw).toMatch(/parentElement/);
  });
  it("the notifications bell says what it is (and how many are unread)", () => {
    expect(read("app/c/page.tsx")).toMatch(/aria-label=\{unreadCount > 0 \? `Notifications, \$\{unreadCount\} unread` : "Notifications"\}/);
  });
  it("the order-row chevron link names the order it opens", () => {
    expect(read("app/c/orders/_components/OrdersClient.tsx")).toMatch(/aria-label=\{`View order/);
  });
});
