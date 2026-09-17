/* Behavioral test for writeSheet's write-then-trim ordering (lib/sheets.ts,
   found 2026-09-17 by code review): the OLD implementation cleared the
   whole tab first and wrote second, so any failure between those two calls
   (a timeout, a transient Google API error, the process dying) left the tab
   completely BLANK until the next sync — for the hourly aggregate sync, up
   to an hour of the Owner opening an empty "Live" or "Students" tab. This
   test proves the new order (write first, trim leftover rows second) never
   produces that outcome: a failed write leaves the OLD data in place, never
   an empty tab, and the trim range starts exactly after the new data. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; url: string }[] = [];

function mockFetch(overrides: { failPut?: boolean; failClear?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push({ method, url });
    if (url.includes(":batchUpdate")) return new Response("{}", { status: 200 });
    if (method === "PUT") {
      if (overrides.failPut) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    }
    if (url.includes(":clear")) {
      if (overrides.failClear) return new Response("boom", { status: 500 });
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

beforeEach(() => {
  calls.length = 0;
  process.env.GOOGLE_SA_EMAIL = "test@example.iam.gserviceaccount.com";
  process.env.GOOGLE_SA_PRIVATE_KEY = TEST_KEY;
  process.env.GOOGLE_SHEET_ID = "test-sheet-id";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A real (throwaway) RSA key so crypto.createSign(...).sign(key) doesn't throw —
// the token endpoint itself is mocked below, so the signature's actual
// validity is irrelevant, only that signing succeeds.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDm1Minf2JzbHs6
7aubrteKyGuFP8fzma4+MSVtty0GBy1Zm5O1DwNCFT1zP1yUC2dmaCo45CeJlHey
/IUjXK1sGgpDBQIaPUvXal/+299yehADReIb7KcffjQKZ40ngzWM0fRuu3cBRig7
WGbwHpNQ2kGyKXg9nvrYaK6Q8c+ZFIkNSzhVc30mzWQUCtSUsRCiNQoIsXPAq6va
ikYtr4zzs1see7KdxajRTLkNEVS+kf/MYhpEv8z8/nvf8EsZko0OUi0RtqsNwVhg
wWGqaOrVfz+xu+fAaeLS6S0L3VUeCqYzbNhlFQRFdVB6LvjhN2S04tFC720WSuee
g+qsuhGXAgMBAAECggEAIG2uTtG3jA2mdk3jePikMUwcxtiCB7gEYZpX7sT4H0us
1FTl+F7Gj2caffFd2TKM8TcbD2kGIO7prgyJy8D+YBx8apPuiq8n03iPSeeryZJa
Y4tSy6eAhw0c1IVdsDpfsIvichgGDPjFOCkgNQWmnoo7BoOK7+VAylxSgexmxNN4
a/pkXFGqaGWITM4lbW5N2Z/Afpa3wAfI5/qdArRgxrrN0mSWuh/MU0oRa/zUopuU
LX52NmZoqrPRJnxHHEeQvlZmi47Ac61HbiUForMdwubn+YWYwTMOHaxxIjhgVG0W
GVyS32treUFVliwVvoBNWxu3nUaV2uJpw/FsLKpPeQKBgQD0SJZSh1iOhdxhNPVg
OP1/7Hio124UGo7AIcRjnpr7dRGPepZxthKOmGwlETORXmD5VSQM3bGchubxw0Nk
YuL2HOK6KbJpzNUqa9nCj1V3f7ShT4dptvDrYZculj/Mqt18ysmnrglhcutipF/a
NOzh6ogu3PySmABL8YMsPqwHtQKBgQDx5wXpbYKYta+C4D08ph1pLFzdzf5hUv05
lQd6JH5E8dbqVNWt76o/enVJb/Hga3JRNBNhRB1663iOFGfKFjuPGtU32Yy/wQ4g
WSgik0F7kJuv+ORSsd1OSPW2+3tfjenGmvk2VPEHmLW56Mf57Sie48skDYX+WT9w
tQ+k3+4rmwKBgCxDVtGfaqFwie0nLmsACJb8XySg3HZSFZmkxLQUUhrMLKFl4gq6
pgQmhDn3MvPdOQ8UqVKXfQ5St1gJPJXdASj9NOvskEJxdhKYtj11wVPE1RMBmRTD
rEXKSh2L5gWM1FM/X2i9tT9uFk6qYB/mxSFuYLy1GCLr3enk2hLTTFKdAoGBAN5D
HrNz42LczP67eoiXOL7B/DHwa6KQ1gpqXAxmK369lnKIsCy44PyiT9HCAcPp9YeX
CZd9NnkSkho5tYOBGghK504BnckyYQBn6vCZzLj0DZiKX3973ZNohhwyxRDvG7VX
/1NkiHIqZg8DS3rf5UrYknX11v/0kM3GDzG2buexAoGADFTOiK1MoXRVmmroY1Oc
kI/CEQU5o3TeAWr8a6ZDdY8bKzX5gnyesIhKVTCi6jkU615n2bhAvW5MV07s/jom
q7erew+ukmTFafJBe3ctmlM+4RWKe1jeqMkYJZRZgo50MLdOY4cSS6W9StLOz1OY
FVu0/0Ngywo2rPLJjcSuovU=
-----END PRIVATE KEY-----`;

describe("writeSheet write-then-trim ordering", () => {
  it("writes data BEFORE trimming leftover rows — never clears before writing", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    const r = await writeSheet("Test", [["a", "b"], ["1", "2"]]);
    expect(r.ok).toBe(true);

    const put = calls.find((c) => c.method === "PUT");
    const clear = calls.find((c) => c.url.includes(":clear"));
    expect(put).toBeDefined();
    expect(clear).toBeDefined();
    expect(calls.indexOf(put!)).toBeLessThan(calls.indexOf(clear!));
  });

  it("the trim range starts exactly one row after the data just written", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    await writeSheet("Test", [["h1", "h2"], ["r1", "r1"], ["r2", "r2"]]); // 3 rows
    const clear = calls.find((c) => c.url.includes(":clear"));
    expect(decodeURIComponent(clear!.url)).toContain("Test!A4:Z1000");
  });

  it("a PUT failure leaves the OLD data untouched — no clear call ever happens", async () => {
    global.fetch = mockFetch({ failPut: true }) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    const r = await writeSheet("Test", [["a"]]);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.includes(":clear"))).toBe(false);
  });

  it("a trim failure after a successful write is reported, but the new data is already live", async () => {
    global.fetch = mockFetch({ failClear: true }) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    const r = await writeSheet("Test", [["a"]]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/trim failed/);
    // the PUT still happened and succeeded before the trim failure
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
  });
});
