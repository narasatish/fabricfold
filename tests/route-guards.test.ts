/* Every page inside an app guards itself.

   proxy.ts turns one forgotten guard into a non-event: a student who reaches
   an unguarded /s page is bounced before it renders. That safety net is not
   portable — Cloudflare Workers cannot run Node middleware, and Next 16 will
   not let a proxy file opt into the Edge runtime — so anywhere but Vercel the
   net is gone.

   This suite is the replacement, and it is arguably the better one: it turns
   "someone might forget" into a failing build rather than a runtime hole that
   only shows up when somebody goes looking. It enumerates the real files, so
   a page added tomorrow is covered without anyone remembering to list it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Every page.tsx under a directory, found on disk rather than hand-listed. */
function pagesUnder(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "page.tsx") out.push(path.relative(ROOT, p).split(path.sep).join("/"));
    }
  };
  walk(abs);
  return out.sort();
}

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const STAFF_PAGES = pagesUnder("app/s");
const CUSTOMER_PAGES = pagesUnder("app/c");

/* A page is guarded if it establishes WHO is asking before it reads anything:
   either a requireStaff/requireStudent call (which hits the database and
   checks active + epoch), or an explicit session-mode check with a redirect. */
const STAFF_GUARD = /requireStaff\(|\.mode !== "staff"/;
const CUSTOMER_GUARD = /requireStudent\(|\.mode !== "customer"/;

describe("the enumeration itself is trustworthy", () => {
  it("finds the staff pages", () => {
    // if this ever hits zero the suite would pass vacuously
    expect(STAFF_PAGES.length).toBeGreaterThanOrEqual(8);
    expect(STAFF_PAGES).toContain("app/s/page.tsx");
    expect(STAFF_PAGES).toContain("app/s/admin/page.tsx");
  });
  it("finds the customer pages", () => {
    expect(CUSTOMER_PAGES.length).toBeGreaterThanOrEqual(9);
    expect(CUSTOMER_PAGES).toContain("app/c/page.tsx");
  });
});

describe("every staff page checks for itself", () => {
  it.each(STAFF_PAGES)("%s", (p) => {
    expect(read(p)).toMatch(STAFF_GUARD);
  });
});

describe("every customer page checks for itself", () => {
  it.each(CUSTOMER_PAGES)("%s", (p) => {
    expect(read(p)).toMatch(CUSTOMER_GUARD);
  });
});

describe("the layouts guard the segment as well", () => {
  /* Belt and braces. A layout redirect stops the navigation; the per-page
     check is what stops a page fetching data, since Next may begin rendering
     a page and its layout in parallel. Both matter — neither replaces the
     other, and neither depends on the proxy. */
  it("staff layout", () => {
    const l = read("app/s/layout.tsx");
    expect(l).toMatch(/session\.mode !== "staff"/);
    expect(l).toMatch(/requireStaff\(1\)/);
    expect(l).toMatch(/redirect\("\/login"\)/);
  });
  it("customer layout", () => {
    const l = read("app/c/layout.tsx");
    expect(l).toMatch(/session\.mode !== "customer"/);
    expect(l).toMatch(/requireStudent\(\)/);
    expect(l).toMatch(/redirect\("\/login"\)/);
  });
});

describe("role is read from the database, never from the cookie", () => {
  it("requireStaff re-reads the row and checks active + epoch on every call", () => {
    /* A token carries whatever the role was when it was signed. Trusting it
       would keep a demoted or removed staff member privileged until their
       cookie expired — up to 30 days. */
    const auth = read("lib/auth.ts");
    const fn = auth.slice(auth.indexOf("export async function requireStaff"));
    expect(fn).toMatch(/db\.staff\.findUnique/);
    expect(fn).toMatch(/if \(!st\.active\)/);
    expect(fn).toMatch(/sessionEpoch/);
    expect(fn).toMatch(/if \(st\.role < minRole\)/);
  });
});
