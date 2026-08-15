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
    const out = [...rows];
    if (header) {
      const first = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!A1:A1`)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const empty = !first.ok || !((await first.json()) as { values?: string[][] }).values?.length;
      if (empty) out.unshift(header);
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

  // Clear then write, so a shrinking dataset doesn't leave stale rows behind.
  const range = encodeURIComponent(`${tab}!A1:Z1000`);
  const clear = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:clear`, {
    method: "POST", headers: auth, body: "{}",
  });
  if (!clear.ok) return { ok: false as const, error: `clear failed (${clear.status}): ${(await clear.text()).slice(0, 200)}` };

  const put = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueInputOption=USER_ENTERED`,
    { method: "PUT", headers: auth, body: JSON.stringify({ values: rows }) },
  );
  if (!put.ok) return { ok: false as const, error: `write failed (${put.status}): ${(await put.text()).slice(0, 200)}` };

  return { ok: true as const, rows: rows.length };
}
