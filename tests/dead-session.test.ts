/* A validly-signed cookie whose account can no longer sign in.

   Happens to real people at exactly the moments the app is meant to handle
   cleanly: staff removed by an admin, a student after "sign out everywhere".
   The old behaviour was a trap — /login saw the cookie and bounced to /s,
   /s threw "Account not found", and the only way out was clearing cookies
   by hand. Reproduced live on 2026-08-23. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const auth = read("lib/auth.ts");
const login = read("app/login/page.tsx");
const sLayout = read("app/s/layout.tsx");
const cLayout = read("app/c/layout.tsx");

describe("liveSession asks the stronger question", () => {
  it("exists and is what the login page uses to decide where to send people", () => {
    expect(auth).toMatch(/export async function liveSession/);
    expect(login).toMatch(/liveSession\(\)/);
    expect(login).not.toMatch(/getSession\(\)/);
  });
  it("returns null for AuthError (removed account, stale epoch) and rethrows anything else", () => {
    const fn = auth.slice(auth.indexOf("export async function liveSession"));
    expect(fn).toMatch(/if \(e instanceof AuthError\) return null;/);
    expect(fn).toMatch(/throw e;/);
  });
});

describe("both app layouts send a dead session to /login, not to the error page", () => {
  for (const [name, src] of [["staff", sLayout], ["customer", cLayout]] as const) {
    it(`${name} layout`, () => {
      expect(src).toMatch(/catch \(e\) \{\s*\n\s*if \(e instanceof AuthError\) redirect\("\/login"\);\s*\n\s*throw e;/);
    });
  }
});
