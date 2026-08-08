/* Point .env at a Supabase project, without the password passing through chat.

   Prompts for the database password with the input hidden, percent-encodes it
   (a password containing @ : / # ? would otherwise break URL parsing and give
   a baffling "invalid port" error), and rewrites DATABASE_URL / DIRECT_URL.

   Run:  node scripts/set-db-env.mjs

   Keeps a timestamped backup of .env, because pointing at the wrong database
   is the exact mistake this whole exercise is fixing. */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(root, ".env");

const PROJECT_REF = "vhwjdnjsruuarcoqduuu";
const HOST = "aws-1-ap-south-1.pooler.supabase.com";

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!hidden) return rl.question(question, (a) => { rl.close(); resolve(a); });
    process.stdout.write(question);
    const onData = (ch) => {
      // swallow the echo so the password never appears on screen or in scrollback
      const s = ch.toString();
      if (s === "\n" || s === "\r" || s === "") process.stdin.removeListener("data", onData);
      else process.stdout.write("*");
    };
    process.stdin.on("data", onData);
    rl.question("", (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

/* --reuse takes the password already in .env and only swaps the project ref and
   host. Useful when both Supabase projects share a password: nothing has to be
   retyped, pasted into a shell, or repeated anywhere it could be captured. */
const REUSE = process.argv.includes("--reuse");

let pw = "";
if (REUSE) {
  const cur = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const m = /^DATABASE_URL="?postgres(?:ql)?:\/\/[^:]+:([^@]+)@/m.exec(cur);
  if (!m) {
    console.error("--reuse: couldn't read a password out of the existing DATABASE_URL.");
    process.exit(1);
  }
  // stored form is already percent-encoded; decode so the re-encode below is
  // idempotent rather than double-escaping a % or @
  pw = decodeURIComponent(m[1]);
  console.log("reusing the password already in .env (not shown)");
} else {
  pw = (await ask(`Database password for ${PROJECT_REF}: `, { hidden: true })).trim();
}

if (!pw) {
  console.error("\nNo password entered — nothing changed.");
  process.exit(1);
}
if (pw === "[YOUR-PASSWORD]") {
  console.error("\nThat's the placeholder from the Supabase page, not your actual password.");
  process.exit(1);
}

const enc = encodeURIComponent(pw);
const DATABASE_URL = `postgresql://postgres.${PROJECT_REF}:${enc}@${HOST}:6543/postgres?pgbouncer=true`;
const DIRECT_URL = `postgresql://postgres.${PROJECT_REF}:${enc}@${HOST}:5432/postgres`;

let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
if (existsSync(ENV)) {
  const backup = `${ENV}.backup-${Date.now()}`;
  copyFileSync(ENV, backup);
  console.log(`backed up  ${path.basename(backup)}`);
}

function upsert(text, key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : (text.trimEnd() + "\n" + line + "\n");
}

env = upsert(env, "DATABASE_URL", DATABASE_URL);
env = upsert(env, "DIRECT_URL", DIRECT_URL);
writeFileSync(ENV, env);

if (enc !== pw) console.log("note: password contained URL-special characters and was percent-encoded");
console.log(`updated    .env → ${HOST}`);
console.log("           DATABASE_URL :6543 (queries)");
console.log("           DIRECT_URL   :5432 (schema changes)");
console.log("\nDone. Tell Claude it's set and it will verify the connection.");
