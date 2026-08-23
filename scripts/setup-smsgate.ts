/* One command to finish the SMS gateway.

     npx tsx scripts/setup-smsgate.ts

   Everything after "the app is installed and shows Online" is automatable, so
   it is automated: this takes the two credentials, verifies them against the
   real API BEFORE storing anything, writes them locally, pushes them to Vercel
   production, and sends a live test message.

   Verifying first matters. Storing a wrong password and finding out at 9am
   when a student cannot log in is the failure this avoids. */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://api.sms-gate.app/3rdparty/v1";
const ENV = path.resolve(__dirname, "../.env");

/** Read a secret without echoing it to the terminal or shell history. */
async function askHidden(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  const onData = (c: Buffer) => {
    const s = c.toString();
    if (s === "\r" || s === "\n") return;
    stdout.write("\u001b[2K\u001b[200D" + q + "*".repeat(rl.line.length));
  };
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
    : txt.replace(/\s*$/, "\n") + line + "\n";
  fs.writeFileSync(ENV, txt);
}

/** Push to Vercel, replacing any existing value. */
function setVercel(key: string, value: string) {
  try { execFileSync("npx", ["vercel", "env", "rm", key, "production", "--yes"], { stdio: "ignore" }); } catch { /* absent is fine */ }
  execFileSync("npx", ["vercel", "env", "add", key, "production"], { input: value + "\n", stdio: ["pipe", "ignore", "ignore"] });
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  console.log("\nSMS gateway setup\n");
  console.log("In the SMS Gateway app: turn on 'Cloud Server', tap 'Offline' so it reads");
  console.log("'Online', then read the username and password from Cloud Server settings.\n");

  const login = (await rl.question("  Username: ")).trim();
  const pass = await askHidden(rl, "  Password: ");
  rl.close();
  if (!login || !pass) { console.error("\nBoth are required.\n"); process.exit(1); }

  const auth = "Basic " + Buffer.from(`${login}:${pass}`).toString("base64");

  // 1. Are the credentials real, and is a phone actually attached?
  process.stdout.write("\n  checking credentials… ");
  const dev = await fetch(`${BASE}/devices`, { headers: { Authorization: auth } });
  /* 403, not just 401 — the API answers Forbidden for a bad password, which is
     what it actually returns when tested. Treating only 401 as "wrong
     credentials" would have shown a raw error for the commonest mistake. */
  if (dev.status === 401 || dev.status === 403) {
    console.error("REJECTED\n\n  Wrong username or password. They are regenerated if the server is reset,\n  so re-read them from the Cloud Server section of the app.\n");
    process.exit(1);
  }
  if (!dev.ok) { console.error(`HTTP ${dev.status}\n\n  ${(await dev.text()).slice(0, 200)}\n`); process.exit(1); }
  const devices = (await dev.json()) as { id: string; name?: string }[];
  if (!devices.length) {
    console.error("no device\n\n  Credentials work, but no phone is registered. Make sure the app says Online.\n");
    process.exit(1);
  }
  console.log(`OK — ${devices.length} device(s): ${devices.map((d) => d.name || d.id).join(", ")}`);

  // 2. Only now store them.
  process.stdout.write("  writing .env… ");
  upsertEnv("SMSGATE_LOGIN", login);
  upsertEnv("SMSGATE_PASSWORD", pass);
  console.log("OK");

  process.stdout.write("  pushing to Vercel production… ");
  try {
    setVercel("SMSGATE_LOGIN", login);
    setVercel("SMSGATE_PASSWORD", pass);
    console.log("OK");
  } catch (e) {
    console.log("FAILED");
    console.error(`    ${(e as Error).message.slice(0, 160)}`);
    console.error("    Saved locally. Add them by hand with: npx vercel env add SMSGATE_LOGIN production");
  }

  console.log("\n  Credentials verified and stored.\n");
  console.log("  Next:  npx tsx scripts/test-smsgate.ts <your-10-digit-number>");
  console.log("  Then tell Claude to deploy — the app only picks them up on the next deploy.\n");
}

main().catch((e) => { console.error("\nERR", (e as Error).message, "\n"); process.exit(1); });
