/* Found 2026-10-21, same audit pass that widened time-ago-hydration.test.ts
   to cover Server Components (that entry: /s/reports crashing blank with
   React error #418). Same bug CLASS, different call: `new Date(x).
   toLocaleTimeString(...)` / `.toLocaleDateString(...)` / `.toLocaleString(...)`
   with NO explicit `timeZone` lets the JS runtime's own local timezone decide
   the formatted string. For a "use client" component that is a real,
   deterministic (not racy) hydration mismatch: Next SSRs every client
   component once on the server (which runs in whatever timezone the host
   sets — UTC on Render) to produce the initial HTML, then React re-executes
   the SAME render function in the browser during hydration, in the visitor's
   own local timezone (IST for every real user of this campus app). A clock
   reading that is genuinely different between the two renders — not a
   mismatch that resolves itself a moment later, but one that is wrong on
   every single load for every user whose browser isn't already set to IST —
   makes React discard the server HTML and rebuild, same as the timeAgo bug.

   Three real instances found: `AdminClient.tsx`'s `hhmm()` helper (staff
   attendance "in HH:MM"), the same file's App-Errors panel timestamp, and
   `HomeClient.tsx`'s "On shift since HH:MM". All three now pass
   `timeZone: "Asia/Kolkata"` explicitly, matching the pattern
   `ComplaintsClient.tsx`'s "Reply by" line already used correctly — this
   test widens the guard so the same mistake can't quietly come back, the
   same way the timeAgo widening did for its own bug class. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "node_modules" || e.name === "generated" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);

describe("Date-formatting calls on a Date always pass an explicit timeZone", () => {
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components"))].filter((f) => /\.tsx$/.test(f));

  // Matches `.toLocaleString(`, `.toLocaleDateString(`, `.toLocaleTimeString(`
  // called on something built from `Date(` (covers `new Date(x).toLocale...`
  // and a `Date`-typed variable/param piped straight in) — not plain number
  // formatting like `n.toLocaleString("en-IN")`, which has no timezone to get
  // wrong. Checked per matched CALL (balanced-paren scan from the opening
  // `(` ), not per line, so a call that wraps need not stay on one line.
  const offenders: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const callRe = /Date\([^;{}]*?\)\.toLocale(?:Date|Time)?String\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src))) {
      const openParen = m.index + m[0].length - 1;
      // Balanced scan from the call's own opening paren to its matching close.
      let depth = 0, i = openParen, end = -1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
      }
      const callArgs = end === -1 ? src.slice(openParen) : src.slice(openParen, end + 1);
      if (!callArgs.includes("timeZone")) {
        offenders.push(`${path.relative(root, f)}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }

  it("has no Date-formatting call missing timeZone", () => {
    expect(offenders).toEqual([]);
  });
});
