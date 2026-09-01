/* One command to finish email sending.

     npx tsx scripts/setup-resend.ts

   Takes the Resend API key, VERIFIES it against the real API before storing
   anything, writes it locally, pushes it to Vercel production, and sends a
   live test email so you find out now — not at 9am when a student cannot log
   in — whether mail actually arrives.

   Same shape as setup-smsgate.ts deliberately, main() included: this project
   has no "type": "module", so tsx runs these as CommonJS and top-level await
   is a syntax error. */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ENV = path.resolve(__dirname, "../.env");
const DEFAULT_FROM = "FabricFold <login@send.fabricfold.in>";

/** Read a secret without echoing it to the terminal or shell history. */
async function askHidden(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  const onData = () => stdout.write("[2K[200D" + q + "*".repeat(rl.line.length));
  stdin.on("data", onData);
  const v = await rl.question(q);
  stdin.off("data", onData);
  stdout.write("\n");
  return v.trim();
}

function upsertEnv(key: string, value: string) {
  let txt = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : "";
  const line = `${key}=${value}`;
  txt = new RegExp(`^${key}=.*$`, "m").test(txt)
    ? txt.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : (txt.endsWith("\n") || txt === "" ? txt : txt + "\n") + line + "\n";
  fs.writeFileSync(ENV, txt);
}

function pushToVercel(key: string, value: string) {
  try {
    // Remove first so re-running doesn't error on an existing variable.
    try { execFileSync("npx", ["vercel", "env", "rm", key, "production", "-y"], { stdio: "ignore", shell: true }); } catch { /* not set yet */ }
    execFileSync("npx", ["vercel", "env", "add", key, "production"], { input: value + "\n", stdio: ["pipe", "ignore", "ignore"], shell: true });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  const key = await askHidden(rl, "Resend API key (starts re_, hidden): ");
  if (!key.startsWith("re_")) { rl.close(); console.error("\nThat doesn't look like a Resend key — they start with re_."); process.exit(1); }

  const from = (await rl.question(`From address [${DEFAULT_FROM}]: `)).trim() || DEFAULT_FROM;
  const to = (await rl.question("Send a test email to: ")).trim();
  rl.close();
  if (!to.includes("@")) { console.error("Need a real address to test with."); process.exit(1); }

  /* Verify BEFORE storing. A key that cannot send is worse than no key: the
     code treats "configured" as "deliverable" and stops offering fallbacks. */
  console.log("\nSending a test email…");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: "FabricFold — test email",
      text: "If you're reading this, FabricFold can send email.\n\nCheck whether this landed in Inbox or Spam — that is the thing worth knowing before logins depend on it.",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`\n✗ Resend refused (HTTP ${res.status}). Nothing was stored.`);
    console.error(`  ${detail}`);
    if (res.status === 401) console.error("\n  → Wrong or revoked API key.");
    if (res.status === 403) console.error("\n  → The key may lack sending access, or the From domain isn't verified.");
    if (res.status === 422) console.error("\n  → The From address must be on a domain verified in Resend.");
    process.exit(1);
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string };
  console.log(`✓ Accepted by Resend (id ${body.id ?? "?"}).`);

  upsertEnv("RESEND_API_KEY", key);
  upsertEnv("MAIL_FROM", from);
  console.log("✓ Written to .env");

  console.log("\nPushing to Vercel production…");
  const a = pushToVercel("RESEND_API_KEY", key);
  const b = pushToVercel("MAIL_FROM", from);
  console.log(a && b ? "✓ Pushed to Vercel" : "✗ Vercel push failed — add them manually with: npx vercel env add RESEND_API_KEY production");

  console.log(`\nNow check ${to}:`);
  console.log("  · Did it arrive?");
  console.log("  · INBOX or SPAM? Spam is the answer that matters — say so and we'll add DMARC.");
  console.log("  · Test a college address (@…ac.in) too. Institutional filters are the real risk.");
}

main().catch((e) => { console.error("\nERR", (e as Error).message, "\n"); process.exit(1); });
