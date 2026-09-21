/* Found in the Sep 21 QA pass reading public/sw.js: the service worker stores
   every successful same-origin GET - including logged-in pages such as the
   wallet and the money reports - in Cache Storage, and signing out never
   cleared it. On a shared phone or the counter tablet the next person could open
   the previous user's pages from the cache when offline. Sign-out now empties
   the page cache (the offline order queue lives elsewhere and is untouched). */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { clearOfflineCaches } from "../lib/client-cache";

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("clearOfflineCaches", () => {
  it("deletes every cache the browser holds", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("window", { });
    vi.stubGlobal("caches", { keys: async () => ["ff-v34", "runtime", "other"], delete: async (k: string) => { deleted.push(k); return true; } });
    await clearOfflineCaches();
    expect(deleted.sort()).toEqual(["ff-v34", "other", "runtime"]);
  });
  it("never throws (no Cache API, or a failing delete must not block sign-out)", async () => {
    vi.stubGlobal("window", { });
    vi.stubGlobal("caches", { keys: async () => { throw new Error("blocked"); } });
    await expect(clearOfflineCaches()).resolves.toBeUndefined();
    vi.unstubAllGlobals();
    await expect(clearOfflineCaches()).resolves.toBeUndefined();
  });
});

describe("every sign-out path clears it", () => {
  it("customer Sign out and Sign out everywhere", () => {
    const src = read("app/c/profile/_components/ProfileClient.tsx");
    expect(src.match(/clearOfflineCaches\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("staff Sign out", () => {
    expect(read("app/s/_components/SignOut.tsx")).toMatch(/clearOfflineCaches\(\)/);
  });
});
