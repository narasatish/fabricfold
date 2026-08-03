/* Regenerate every app icon and the social preview from ONE source logo.

   Drop the artwork at brand/logo.png (square, ideally 1024px+) and run:
     node scripts/build-icons.mjs

   Why a script rather than hand-exported files: the icons must stay in step
   with each other. Replacing one by hand and forgetting the maskable variant
   is how an app ends up with the old mark on some Android launchers and the
   new one everywhere else.

   Uses sharp, which Next already depends on for image optimization — no new
   package. If Next ever drops it, this script fails loudly rather than
   silently producing nothing.

   Maskable icons get real padding: Android crops to a circle on many
   launchers, so artwork drawn edge-to-edge loses its corners. The safe zone is
   the middle 80%, hence the inset. */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "brand", "logo.png");
const OUT = path.join(root, "public");

if (!existsSync(SRC)) {
  console.error(
    `No source logo at brand/logo.png\n` +
      `Save the artwork there (square PNG, 1024px or larger) and run this again.`,
  );
  process.exit(1);
}

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error("sharp is unavailable — install it with `npm i -D sharp` and retry.");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

/* Brand background for the social card and the padded maskable icons. Taken
   from the logo's sky, so a transparent PNG doesn't composite onto black. */
const BG = { r: 235, g: 245, b: 253, alpha: 1 };

const meta = await sharp(SRC).metadata();
if ((meta.width ?? 0) < 512) {
  console.warn(`Warning: source is only ${meta.width}px wide — 1024px+ gives crisper icons.`);
}

async function square(size, file, { maskable = false } = {}) {
  const inner = maskable ? Math.round(size * 0.8) : size;
  const pad = Math.round((size - inner) / 2);
  await sharp(SRC)
    .resize(inner, inner, { fit: "contain", background: { ...BG, alpha: 0 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: maskable ? BG : { ...BG, alpha: 0 } })
    .png()
    .toFile(path.join(OUT, file));
  console.log(`  ${file.padEnd(28)} ${size}×${size}${maskable ? "  (maskable, 80% safe zone)" : ""}`);
}

console.log("Generating icons from brand/logo.png");
await square(192, "icon-192.png");
await square(512, "icon-512.png");
await square(512, "icon-maskable-512.png", { maskable: true });
await square(180, "apple-touch-icon.png");

/* Social preview: 1200×630 is the size Open Graph and Twitter both crop from.
   The logo is centred on the brand background rather than stretched. */
const OG_W = 1200, OG_H = 630;
const logo = await sharp(SRC).resize(440, 440, { fit: "contain", background: { ...BG, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: OG_W, height: OG_H, channels: 4, background: BG } })
  .composite([{ input: logo, gravity: "centre" }])
  .png()
  .toFile(path.join(OUT, "og.png"));
console.log(`  ${"og.png".padEnd(28)} ${OG_W}×${OG_H}  (social preview)`);

console.log("\nDone. Commit the regenerated files in public/.");
