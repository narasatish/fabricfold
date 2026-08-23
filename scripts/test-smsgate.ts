/* Send one real SMS through SMS-Gate and follow it to delivery.

     npx tsx scripts/test-smsgate.ts 7799661888

   "It didn't arrive" has several causes that look identical from inside the
   app: wrong credentials, the phone offline, SMS permission never granted, no
   balance on the SIM. This calls the API directly, then polls the message
   until the gateway reports a final state, and names the cause.

   Endpoint and payload follow the published OpenAPI spec:
   https://capcom6.github.io/android-sms-gateway/swagger.json */
import "dotenv/config";

const BASE = "https://api.sms-gate.app/3rdparty/v1";
const phone = (process.argv[2] || "").replace(/\D/g, "").slice(-10);

if (phone.length !== 10) {
  console.error("Pass a 10-digit Indian mobile:  npx tsx scripts/test-smsgate.ts 7799661888");
  process.exit(1);
}

const login = process.env.SMSGATE_LOGIN;
const pass = process.env.SMSGATE_PASSWORD;
if (!login || !pass) {
  console.error(
    "SMSGATE_LOGIN / SMSGATE_PASSWORD are not set.\n" +
      "Open the SMS Gate app on the Android phone, switch the server on in Cloud mode,\n" +
      "and copy the username and password it shows.",
  );
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${login}:${pass}`).toString("base64");
const headers = { "Content-Type": "application/json", Authorization: auth };

/** Turn an HTTP status into something actionable. */
function explain(status: number, body: string) {
  // The API returns 403 for a bad password, not only 401 — verified against it.
  if (status === 401 || status === 403) return "Wrong username or password. Re-read them from the Cloud Server section of the app — they are regenerated if the server is reset.";
  if (status === 400) return `The gateway rejected the request: ${body.slice(0, 200)}`;
  if (status === 503) return "THE PHONE IS OFFLINE. It must be powered on, online, and the SMS Gate app running.";
  return `HTTP ${status}: ${body.slice(0, 200)}`;
}

async function main() {
  console.log(`\nSMS-Gate test -> +91${phone}`);

  // 1. Is a device actually registered and reachable?
  const dev = await fetch(`${BASE}/devices`, { headers });
  if (!dev.ok) {
    console.error(`\n  x cannot list devices — ${explain(dev.status, await dev.text().catch(() => ""))}\n`);
    process.exit(1);
  }
  const devices = (await dev.json()) as { id: string; name?: string; lastSeen?: string }[];
  if (!devices.length) {
    console.error("\n  x no device registered. Turn the server ON in the app while signed into this account.\n");
    process.exit(1);
  }
  for (const d of devices) console.log(`  device: ${d.name || d.id}${d.lastSeen ? ` · last seen ${d.lastSeen}` : ""}`);

  // 2. Send.
  const text = `FabricFold test — your login OTP is 123456. It expires in 5 minutes.`;
  const res = await fetch(`${BASE}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [`+91${phone}`] }),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error(`\n  x send rejected — ${explain(res.status, raw)}\n`);
    process.exit(1);
  }
  const sent = JSON.parse(raw) as { id: string; state?: string };
  console.log(`  queued: id=${sent.id} state=${sent.state ?? "Pending"}`);

  /* 3. Follow it. Enqueued is not sent — the phone still has to do the work,
        and that is exactly where a missing SMS permission or an empty SIM
        shows up. Final states per the spec: Sent, Delivered, Failed, Cancelled. */
  const FINAL = new Set(["Sent", "Delivered", "Failed", "Cancelled"]);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`${BASE}/messages/${sent.id}`, { headers });
    if (!st.ok) continue;
    const m = (await st.json()) as { state: string; recipients?: { phoneNumber: string; state: string; error?: string }[] };
    process.stdout.write(`  ${m.state}\r`);
    if (FINAL.has(m.state)) {
      console.log(`  final state: ${m.state}          `);
      for (const r of m.recipients ?? []) {
        console.log(`    ${r.phoneNumber}: ${r.state}${r.error ? ` — ${r.error}` : ""}`);
      }
      if (m.state === "Failed") {
        console.error("\n  x the phone could not send it. Usual causes: SMS permission not granted to the app, no SIM credit, or the SIM blocked for outbound SMS.\n");
        process.exit(1);
      }
      console.log("\n  OK — check the handset.\n");
      return;
    }
  }
  console.log("\n  still pending after 60s. The phone accepted it but has not reported back; check the app is running.\n");
}

main().catch((e) => { console.error("ERR", (e as Error).message); process.exit(1); });
