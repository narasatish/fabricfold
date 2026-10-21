/* Found in the Sep 21 QA pass (Next.js hydration error on the staff order
   page): client components rendered `timeAgo(x)` directly, so the server said
   "just now" and the browser said "1m ago" a second later. Any relative time
   whose age crosses a minute boundary between server render and hydration
   mismatched, and React discards the server HTML and rebuilds on the client.
   The fix is a TimeAgo component whose first render is identical on server and
   client (empty) and which fills in after mount. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { TimeAgo } from "../components/time-ago";

const root = path.resolve(__dirname, "..");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "node_modules" || e.name === "generated" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);

describe("TimeAgo", () => {
  it("renders the same thing on the server no matter how old the timestamp is", () => {
    const a = renderToString(createElement(TimeAgo, { at: Date.now() - 5_000 }));
    const b = renderToString(createElement(TimeAgo, { at: Date.now() - 5 * 86_400_000 }));
    expect(a.replace(/<[^>]+>/g, "")).toBe("");
    expect(b.replace(/<[^>]+>/g, "")).toBe("");
  });
});

describe("client components never call timeAgo() directly", () => {
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components"))].filter((f) => /\.tsx$/.test(f) && !f.endsWith("time-ago.tsx")); // TimeAgo itself calls it, after mount
  const offenders = files.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return /^["']use client["']/m.test(src.slice(0, 200)) && /\btimeAgo\(/.test(src);
  });
  it("uses <TimeAgo/> instead", () => {
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});

/* Found 2026-10-21 (live staff-side testing, /s/reports crashed blank with
   React error #418): the guard above only ever checked explicit "use client"
   files. A plain Server Component calling timeAgo() straight into its JSX —
   no directive at all, so the regex above never saw it — has the EXACT same
   failure mode: the server embeds "just now" into the HTML, hydration runs a
   moment later, the clock has moved on, React discards the mismatched
   subtree. Four page.tsx files were doing this (orders/[id], notifications,
   help, s/reports) and all four are now fixed to use <TimeAgo/> instead —
   this widens the same guard so a server component can't reintroduce it. */
describe("server components never call timeAgo() directly either", () => {
  const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "components"))].filter((f) => /\.tsx$/.test(f) && !f.endsWith("time-ago.tsx"));
  const offenders = files.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return !/^["']use client["']/m.test(src.slice(0, 200)) && /\btimeAgo\(/.test(src);
  });
  it("uses <TimeAgo/> instead", () => {
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
