/* Capture Play Store phone screenshots from the real running app.
   Uses the installed Chrome via puppeteer-core (no bundled browser).
   Run against a local production build so the OTP is the dev code.

   Output: 1080x1920 (9:16) PNGs — within Play's 320..3840 / 16:9..9:16 rules. */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.SHOOT_BASE || "http://localhost:3015";
const PHONE = process.env.SHOOT_PHONE || "8019121966";
const OTP = process.env.SHOOT_OTP || "123456";
const OUT = path.resolve("android/play-assets/screenshots");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  // 360x640 CSS px at 3x = 1080x1920 device px — a real phone screenshot size
  await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  // ---- sign in ----
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="tel"]');
  await page.type('input[type="tel"]', PHONE, { delay: 15 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /send otp/i.test(x.textContent));
    b && b.click();
  });
  await page.waitForSelector('input[maxlength="6"]', { timeout: 15000 });
  await page.type('input[maxlength="6"]', OTP, { delay: 15 });
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /verify & sign in/i.test(x.textContent));
    b && b.click();
  });
  await page.waitForFunction(() => location.pathname.startsWith("/c"), { timeout: 20000 });
  await sleep(1200);

  // ---- shots ----
  const shots = [
    { file: "1-home.png", url: "/c", wait: 1600 },
    {
      file: "2-new-order.png",
      url: "/c/order/new?service=washIron",
      wait: 1800,
      // An empty basket showing "0 pcs / Rs 0" is a dead store listing — add real
      // pieces so the shot shows actual pricing and the express maths.
      prep: async (p) => {
        await p.evaluate(() => {
          const plus = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "+");
          for (let i = 0; i < 6; i++) plus[0]?.click();
          for (let i = 0; i < 2; i++) plus[1]?.click();
        });
        await sleep(700);
      },
    },
    { file: "3-tracking.png", url: "/c/orders", wait: 1600 },
    { file: "4-plans.png", url: "/c/wallet", wait: 1800 },
  ];

  for (const s of shots) {
    await page.goto(BASE + s.url, { waitUntil: "networkidle2" });
    await sleep(s.wait);
    if (s.prep) await s.prep(page);
    // hide the install banner — it's not part of the product story
    await page.evaluate(() => {
      const d = document.querySelector('[aria-label="Install FabricFold"]');
      if (d) d.style.display = "none";
    });
    const out = path.join(OUT, s.file);
    await page.screenshot({ path: out, type: "png" });
    const kb = (fs.statSync(out).size / 1024).toFixed(0);
    console.log(`${s.file.padEnd(18)} <- ${s.url}  (${kb} KB)`);
  }

  await browser.close();
  console.log("\nSaved to:", OUT);
}

main().catch((e) => {
  console.error("SHOOT FAILED:", e.message);
  process.exit(1);
});
