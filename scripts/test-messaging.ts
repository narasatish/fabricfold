/* Send one real SMS and/or WhatsApp message, and say exactly what happened.

     npx tsx scripts/test-messaging.ts 7799661888

   Exists because "it didn't arrive" has half a dozen causes that look
   identical from inside the app — unverified trial recipient, missing DLT
   registration, the WhatsApp 24-hour window, a wrong From number. This calls
   the providers directly and reports the actual API response, so the cause is
   named rather than guessed at. */
import "dotenv/config";

const phone = (process.argv[2] || "").replace(/\D/g, "").slice(-10);
if (phone.length !== 10) {
  console.error("Pass a 10-digit Indian mobile: npx tsx scripts/test-messaging.ts 7799661888");
  process.exit(1);
}

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SMS_FROM = process.env.TWILIO_FROM;
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;

function explain(status: number, body: string) {
  const code = (body.match(/"code":\s*(\d+)/) || [])[1];
  const known: Record<string, string> = {
    "21608": "TRIAL ACCOUNT: this number isn't verified. Twilio Console → Phone Numbers → Verified Caller IDs.",
    "21211": "The To number isn't valid E.164 — check the country code.",
    "21606": "The From number can't send SMS. Buy an SMS-capable number, or check TWILIO_FROM.",
    "21610": "That recipient replied STOP. They must text START to resume.",
    "63016": "WHATSAPP 24-HOUR WINDOW: no recent message from them, and free text isn't allowed outside it. Have them message your sandbox number, or use an approved template.",
    "63007": "TWILIO_WHATSAPP_FROM isn't a WhatsApp-enabled sender. For the sandbox use whatsapp:+14155238886.",
    "20003": "Authentication failed — check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
  };
  if (code && known[code]) return `Twilio ${code}: ${known[code]}`;
  return `HTTP ${status} ${body.slice(0, 200)}`;
}

async function send(kind: "SMS" | "WhatsApp", to: string, from: string) {
  const form = new URLSearchParams({
    To: to,
    From: from,
    Body: `FabricFold ${kind} test — if you can read this, ${kind} delivery works.`,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const text = await res.text();
  if (res.ok) {
    const sid = (text.match(/"sid":\s*"([^"]+)"/) || [])[1];
    const status = (text.match(/"status":\s*"([^"]+)"/) || [])[1];
    console.log(`  ✓ ${kind} accepted by Twilio (status "${status}", sid ${sid})`);
    console.log(`    Accepted is not delivered — check the handset, and Twilio Console → Monitor → Logs`);
    return true;
  }
  console.log(`  ✗ ${kind} rejected`);
  console.log(`    ${explain(res.status, text)}`);
  return false;
}

async function main() {
  console.log(`\nTesting delivery to +91 ${phone}\n`);

  if (!SID || !TOKEN) {
    console.log("  – Twilio not configured (need TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)");
    process.exit(1);
  }
  console.log(`  account : ${SID.slice(0, 8)}…`);

  if (SMS_FROM) await send("SMS", `+91${phone}`, SMS_FROM);
  else console.log("  – SMS skipped: TWILIO_FROM not set");

  if (WA_FROM) {
    const from = WA_FROM.startsWith("whatsapp:") ? WA_FROM : `whatsapp:${WA_FROM}`;
    await send("WhatsApp", `whatsapp:+91${phone}`, from);
  } else {
    console.log("  – WhatsApp skipped: TWILIO_WHATSAPP_FROM not set");
  }
  console.log("");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
