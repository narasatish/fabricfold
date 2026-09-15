/* The bottom tab bar must be visible without scrolling, on every screen,
   AND without being partly hidden behind a mobile browser's dynamic
   toolbar.

   History:
   - 2026-08-23 (owner report, screenshot): .tabbar was position:absolute
     inside #app, which was min-height rather than height — so on any page
     taller than the window (Reports, Admin, a busy queue) #app itself grew
     to fit the content, and the tab bar sat at the bottom of the PAGE,
     appearing only after scrolling to the end. Fixed by switching to
     position:fixed.
   - 2026-09-15 (owner report, iOS Chrome screenshot): position:fixed anchors
     to the browser's LAYOUT viewport, which several mobile browsers keep at
     its LARGEST possible size regardless of whether the dynamic toolbar
     (URL bar / tab switcher) is currently showing — env(safe-area-inset-*)
     does NOT account for this, it only covers the device's own notch/home
     indicator. Both the tab bar and any open Sheet's bottom button could
     end up partly behind the browser's own toolbar.

   The fix for #2 without reintroducing #1: #app is now a HARD 100dvh (not
   min-height), which makes .screen's overflow-y:auto truly scroll
   INTERNALLY — #app itself can never grow taller than the visible area,
   on any page, regardless of content length. With that guarantee in place,
   .tabbar (and .sheet-bg, #toast) can safely use position:absolute against
   #app instead of position:fixed against the raw viewport — #app's 100dvh
   tracks the real visible height (dynamic toolbar included) the same way
   it already sizes the app shell itself. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "..", "app/globals.css"), "utf8");
const appRule = css.match(/^#app\{[^}]*\}/m)?.[0] ?? "";
const rule = css.match(/^\.tabbar\{[^}]*\}/m)?.[0] ?? "";
const sheetBgRule = css.match(/^\.sheet-bg\{[^}]*\}/m)?.[0] ?? "";
const toastRule = css.match(/^#toast\{[^}]*\}/m)?.[0] ?? "";

describe("#app is a hard height cap, not min-height", () => {
  it("uses height:100dvh (with a height:100vh fallback), never min-height", () => {
    // The exact bug that made position:absolute unsafe the first time: with
    // min-height, a flex child's overflow-y:auto does not actually cap the
    // parent — content taller than the viewport grows #app instead of
    // scrolling internally. A hard height forces real internal scrolling.
    expect(appRule).toMatch(/height:100vh/);
    expect(appRule).toMatch(/height:100dvh/);
    expect(appRule).not.toMatch(/min-height/);
  });
});

describe("tab bar, sheet, and toast are pinned to #app's real visible height", () => {
  it("the tab bar is position:absolute against #app, not position:fixed against the raw viewport", () => {
    expect(rule).toMatch(/position:absolute/);
    expect(rule).not.toMatch(/position:fixed/);
  });
  it("the sheet backdrop is position:absolute against #app too — a sheet's own bottom button has the same failure mode", () => {
    expect(sheetBgRule).toMatch(/position:absolute/);
    expect(sheetBgRule).not.toMatch(/position:fixed/);
  });
  it("the toast is position:absolute against #app too, for the same reason", () => {
    expect(toastRule).toMatch(/position:absolute/);
    expect(toastRule).not.toMatch(/position:fixed/);
  });
  it("stays centred on the 440px column like .sheet and #toast", () => {
    // left:50% + translateX(-50%) + max-width is the same recipe the other
    // overlays use; a full-width bar would look wrong on a laptop
    expect(rule).toMatch(/left:50%/);
    expect(rule).toMatch(/translateX\(-50%\)/);
    expect(rule).toMatch(/max-width:440px/);
  });
  it("content still reserves room underneath the tab bar — the REAL bar height, not a flat guess", () => {
    /* 96px was a fixed guess at the tab bar's height; on an iPhone with a
       home indicator the bar's actual height is taller by
       env(safe-area-inset-bottom) (~34px), so a flat 96px hid the last inch
       of every screen behind it. See tests/mobile-fixes.test.ts. */
    expect(css).toMatch(/\.screen\{[^}]*padding-bottom:calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
  });
});
