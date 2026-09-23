/* Found live, 2026-09-23: clicking Admin → "Sync to Google Sheet" left the
   button stuck on "Syncing…" with no feedback — not for a few seconds, but
   for 2.9 minutes (confirmed in the dev server's own request log: `POST
   /s/admin [200] in 2.9min`). runSheetsSync already wraps the whole sync in
   a try/catch (see its own comment, dated 2026-09-10, about a PREVIOUS
   version of this exact bug where a thrown error left the button hung
   forever) — but a fetch() that never settles at all never throws, so it
   slips straight past that catch. None of the raw fetch() calls in
   lib/sheets.ts carried a timeout, so a single stalled connection to Google
   could hang the whole operation indefinitely regardless of the outer
   try/catch. This locks the fix: every fetch in that file now runs under a
   bounded AbortSignal. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const sheets = fs.readFileSync(path.resolve(__dirname, "..", "lib/sheets.ts"), "utf8");

describe("every outbound Sheets fetch is bounded by a timeout", () => {
  it("defines a shared withTimeout helper using AbortSignal.timeout", () => {
    expect(sheets).toMatch(/const TIMEOUT_MS = 15_000/);
    expect(sheets).toMatch(/const withTimeout = \(init: RequestInit = \{\}\): RequestInit => \(\{ \.\.\.init, signal: AbortSignal\.timeout\(TIMEOUT_MS\) \}\)/);
  });
  it("every await fetch( call in the file passes through withTimeout", () => {
    // A bare `await fetch(url, someInit)` with no withTimeout() wrapping is
    // exactly the bug: it can hang forever on a stalled connection.
    const positions: number[] = [];
    let idx = sheets.indexOf("await fetch(");
    while (idx !== -1) { positions.push(idx); idx = sheets.indexOf("await fetch(", idx + 1); }
    expect(positions.length).toBeGreaterThan(0);
    for (const p of positions) {
      const window = sheets.slice(p, p + 300);
      expect(window, window).toMatch(/withTimeout\(/);
    }
  });
  it("gfetch (used by writeSheet and appendSheet, with retries) also times out each attempt", () => {
    const gfetchBody = sheets.slice(sheets.indexOf("async function gfetch"), sheets.indexOf("async function gfetch") + 600);
    expect(gfetchBody).toMatch(/fetch\(url, withTimeout\(init\)\)/);
  });
});
