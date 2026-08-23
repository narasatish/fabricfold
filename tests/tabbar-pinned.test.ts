/* The bottom tab bar must be visible without scrolling, on every screen.

   It was position:absolute inside #app, which is min-height rather than
   height — so on any page taller than the window (Reports, Admin, a busy
   queue) it sat at the bottom of the PAGE and appeared only after scrolling
   to the end. Reported by the owner on 2026-08-23, with a screenshot. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "..", "app/globals.css"), "utf8");
const rule = css.match(/^\.tabbar\{[^}]*\}/m)?.[0] ?? "";

describe("tab bar is pinned to the viewport", () => {
  it("is fixed, not absolute", () => {
    expect(rule).toMatch(/position:fixed/);
    expect(rule).not.toMatch(/position:absolute/);
  });
  it("stays centred on the 440px column like .sheet and #toast", () => {
    // left:50% + translateX(-50%) + max-width is the same recipe the other
    // fixed overlays use; a full-width bar would look wrong on a laptop
    expect(rule).toMatch(/left:50%/);
    expect(rule).toMatch(/translateX\(-50%\)/);
    expect(rule).toMatch(/max-width:440px/);
  });
  it("content still reserves room underneath it", () => {
    expect(css).toMatch(/\.screen\{[^}]*padding-bottom:96px/);
  });
});
