/* Google Sheets writer — service-account auth, no SDK dependency.

   PRIVACY CONTRACT: this module must only ever receive aggregate business
   figures. No student names, phone numbers or addresses. A Sheet can be shared
   with one careless click, and our /privacy page does not name Google as a
   processor of personal data. Keep it that way — if you ever need per-student
   rows here, update the privacy policy FIRST.

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
