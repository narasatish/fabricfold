/* 2026-10-31: a real Sentry alert — "SecurityError: Failed to read the
   'localStorage' property from 'Window'", 40 occurrences, escalating —
   traced to components/chrome.tsx: AppShell's theme-restore effect and
   toggleTheme() called localStorage directly, unguarded. Safari private
   browsing (and storage-blocked contexts generally) throws SecurityError
   just touching `localStorage`, not only on quota. AppShell wraps every
   page, so this fired on effectively every page load for an affected
   visitor. useCampusSwitch (same file) already got this right with
   try/catch — this suite pins the same discipline onto the theme code,
   and generally onto every localStorage call-site in this file, so a
   future addition can't reintroduce the gap. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("every localStorage call in components/chrome.tsx is guarded", () => {
  const src = read("components/chrome.tsx");

  it("theme-restore effect wraps localStorage.getItem in try/catch", () => {
    const effect = src.slice(src.indexOf("useEffect(() => {"), src.indexOf("useEffect(() => {") + 300);
    expect(effect).toMatch(/try\s*{[\s\S]*localStorage\.getItem\("ff_theme"\)[\s\S]*}\s*catch/);
  });

  it("toggleTheme wraps localStorage.setItem in try/catch", () => {
    const fn = src.slice(src.indexOf("export function toggleTheme"));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).toMatch(/try\s*{\s*localStorage\.setItem\("ff_theme", next\);\s*}\s*catch/);
  });

  it("no bare (unguarded) localStorage call anywhere in the file", () => {
    /* Every occurrence of `localStorage.` in this file must be immediately
       preceded by a `try {` on the same or prior line (allowing for the
       one-liner try-catch style used here), not called bare the way the
       theme code used to be. We check this by requiring every
       `localStorage.` line to also contain or be wrapped by `try`. */
    const lines = src.split("\n");
    const offenders: number[] = [];
    lines.forEach((line, i) => {
      if (!line.includes("localStorage.")) return;
      const windowStart = Math.max(0, i - 3);
      const window = lines.slice(windowStart, i + 1).join("\n");
      if (!/try\s*{/.test(window)) offenders.push(i + 1);
    });
    expect(offenders).toEqual([]);
  });
});
