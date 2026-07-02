/* Generate VAPID keys for Web Push: npx tsx scripts/vapid.ts
   Paste the output into .env (and Vercel env vars). */
import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + keys.publicKey);
console.log("VAPID_PRIVATE_KEY=" + keys.privateKey);
