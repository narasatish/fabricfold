/* Read-only diagnosis for "Application does not have permission":
   shows which WhatsApp Business Accounts the token is ACTUALLY scoped to,
   versus the WABA ID you are trying to use. Changes nothing. */
import readline from "node:readline";

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const onData = (ch) => {
        const s = ch.toString();
        if (s === "\n" || s === "\r" || s === "") return;
        readline.moveCursor(process.stdout, -s.length, 0);
        process.stdout.write("*".repeat(s.length));
      };
      process.stdin.on("data", onData);
      rl.question(q, (a) => { process.stdin.off("data", onData); rl.close(); process.stdout.write("\n"); resolve(a.trim()); });
    } else {
      rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
    }
  });
}

const token = await ask("Access token (hidden): ", { hidden: true });
const wabaId = await ask("WABA ID you tried (or Enter to skip): ");
const phoneId = await ask("Phone number ID from API Setup (or Enter to skip): ");
const get = async (path) => {
  const r = await fetch(`https://graph.facebook.com/v20.0/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 1. What is this token allowed to touch?
const dbg = await get(`debug_token?input_token=${encodeURIComponent(token)}`);
const data = dbg.body.data || {};
console.log(`\n— Token —`);
console.log(`  app        : ${data.application || "?"} (id ${data.app_id || "?"})`);
console.log(`  valid      : ${data.is_valid}`);
console.log(`  expires    : ${data.expires_at ? new Date(data.expires_at * 1000).toLocaleString() : "?"}`);
console.log(`  scopes     : ${(data.scopes || []).join(", ") || "(none reported)"}`);
const gran = (data.granular_scopes || []).find((g) => g.scope === "whatsapp_business_management");
const allowedWabas = gran?.target_ids || [];
console.log(`  WABAs this token can MANAGE: ${allowedWabas.length ? allowedWabas.join(", ") : "(none / all in scope)"}`);

// 2. Name each allowed WABA so they're recognisable.
for (const id of allowedWabas) {
  const w = await get(`${id}?fields=id,name`);
  console.log(`    · ${id} = "${w.body.name || w.body.error?.message || "?"}"`);
}

// 3. The WABA they tried.
if (wabaId) {
  const w = await get(`${wabaId}?fields=id,name`);
  console.log(`\n— WABA you tried (${wabaId}) —`);
  console.log(`  readable   : ${w.status === 200 ? `yes — "${w.body.name}"` : `NO — ${w.body.error?.message || w.status}`}`);
  console.log(`  in token's manage list: ${allowedWabas.length === 0 ? "n/a" : allowedWabas.includes(wabaId) ? "YES" : "NO ← this is the problem"}`);
}

// 4. Which WABA does the test phone number belong to?
if (phoneId) {
  const p = await get(`${phoneId}?fields=id,display_phone_number,verified_name`);
  console.log(`\n— Phone number ${phoneId} —`);
  if (p.status === 200) console.log(`  number     : ${p.body.display_phone_number} ("${p.body.verified_name}")`);
  else console.log(`  NOT readable with this token: ${p.body.error?.message || p.status}`);
}

console.log(`\nPaste this output (it contains no secrets) back into the chat.`);
