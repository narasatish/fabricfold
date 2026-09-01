/* Create the fabricfold_otp WhatsApp authentication template via the Graph
   API — the workaround for WhatsApp Manager's blank "does not have permission"
   error, and the diagnosis for it: the API returns the REAL reason.

   Run:  node scripts/create-wa-template.mjs
   It prompts for the WABA ID (App dashboard → WhatsApp → API Setup →
   "WhatsApp Business Account ID") and the access token (hidden as you type).
   Nothing is stored. */
import readline from "node:readline";

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Mask the token: echo * instead of the typed character.
      const onData = (ch) => {
        const s = ch.toString();
        if (s === "\n" || s === "\r" || s === "") return;
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

const wabaId = await ask("WhatsApp Business Account ID: ");
const token = await ask("Access token (hidden): ", { hidden: true });
if (!/^\d{5,}$/.test(wabaId)) { console.error("That doesn't look like a WABA ID (digits only)."); process.exit(1); }
if (token.length < 20) { console.error("That doesn't look like a token."); process.exit(1); }

const res = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "fabricfold_otp",
    language: "en_US",
    category: "AUTHENTICATION",
    components: [
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 5 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] },
    ],
  }),
});

const body = await res.json().catch(() => ({}));
if (res.ok && body.id) {
  console.log(`\n✓ Template created (id ${body.id}, status ${body.status || "PENDING"}).`);
  console.log("It will show as In review → Approved in WhatsApp Manager, usually within minutes.");
} else {
  const err = body.error || {};
  console.error(`\n✗ Meta refused (HTTP ${res.status}).`);
  console.error(`  message : ${err.message || JSON.stringify(body)}`);
  if (err.error_user_title) console.error(`  title   : ${err.error_user_title}`);
  if (err.error_user_msg) console.error(`  detail  : ${err.error_user_msg}`);
  console.error("\nPaste the message/detail lines (NOT the token) back into the chat.");
}
