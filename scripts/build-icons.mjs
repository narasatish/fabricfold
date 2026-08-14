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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/* Palette-quantised PNG for everything the browser downloads.

   The artwork is a photographic render — sky, gradients, a glossy flask — so a
   straight 24-bit PNG of it is enormous: the login logo came out at 335 KB,
   and it is the largest element on the first screen a student ever sees, i.e.
   the LCP. Quantising to a 256-colour palette takes it to a fraction of that
   with no visible difference at the sizes these are displayed.

   NOT used for the .ico payload: Next's ICO decoder demands RGBA, and a
   palette PNG fails it. */
const PNG = { palette: true, quality: 80, effort: 10 };

const meta = await sharp(SRC).metadata();
if ((meta.width ?? 0) < 512) {
  console.warn(`Warning: source is only ${meta.width}px wide — 1024px+ gives crisper icons.`);
}

/* App icons use the MARK only — flask, F and folded towel — not the full
   artwork. The wordmark is set small inside the source logo, so at 32px in a
   browser tab "FabricFold" collapses into an illegible smudge and the mark it
   sits under shrinks to nothing. Cropping to the mark makes the icon read at
   tab size; the wordmark still appears wherever there is room for it (the nav,
   the login screen, the social card).

   Expressed as fractions of the source so re-exporting the artwork at a
   different resolution doesn't silently shift the crop. */
const MARK = { x: 0.199, y: 0.133, size: 0.622 };
const W = meta.width ?? 0;
const markCrop = {
  left: Math.round(MARK.x * W),
  top: Math.round(MARK.y * W),
  width: Math.round(MARK.size * W),
  height: Math.round(MARK.size * W),
};

async function square(size, file, { maskable = false } = {}) {
  const inner = maskable ? Math.round(size * 0.8) : size;
  const pad = Math.round((size - inner) / 2);
  await sharp(SRC)
    .extract(markCrop)
    .resize(inner, inner, { fit: "contain", background: { ...BG, alpha: 0 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: maskable ? BG : { ...BG, alpha: 0 } })
    .png(PNG)
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
  .png(PNG)
  .toFile(path.join(OUT, "og.png"));
console.log(`  ${"og.png".padEnd(28)} ${OG_W}×${OG_H}  (social preview)`);

/* Two in-app assets, so screens never reach for an icon sized for a launcher.

   logo-mark.png  — the mark alone, for the nav and app headers where the word
                    "FabricFold" is already set in text beside it.
   logo-full.png  — mark plus wordmark, for the login screen, where the logo is
                    the only branding on an otherwise empty first screen.

   Neither is transparent, and that is not an oversight to fix later: the
   artwork is a painted scene with a sky gradient behind the mark, so there is
   no flat colour to key out. Both therefore carry a pale square, and the
   screens using them round the corners and sit them on light surfaces rather
   than pretending the background isn't there. A cut-out version would have to
   come from the designer, not from a threshold here. */
await sharp(SRC)
  .extract(markCrop)
  .resize(256, 256)
  .png(PNG)
  .toFile(path.join(OUT, "logo-mark.png"));
console.log(`  ${"logo-mark.png".padEnd(28)} 256×256  (nav / app header)`);

await sharp(SRC)
  .resize(512, 512, { fit: "inside" })
  .png(PNG)
  .toFile(path.join(OUT, "logo-full.png"));
console.log(`  ${"logo-full.png".padEnd(28)} ≤512  (login screen)`);

/* app/favicon.ico — the legacy fallback.

   Next serves app/favicon.ico at /favicon.ico automatically, and browsers ask
   for that path whether or not the <link> tags mention it. Leaving a stale one
   there is how a site ends up with the new logo in the manifest and the old
   one in the tab, so it is generated from the same source as everything else.

   ICO is a container: an entry describing the image, then the image itself.
   Since Vista that payload may be a PNG, so this wraps one rather than
   encoding BMP by hand. A 0 byte in the size field means 256 — hence the
   `& 0xff`, which is only ever exercised if SIZE is raised to 256.

   ensureAlpha is not cosmetic: the source is a JPEG, so sharp emits a 3-channel
   RGB PNG, and Next's ICO decoder rejects that outright with "The PNG is not in
   RGBA format!" — a build failure, not a bad-looking icon. */
const ICO_SIZE = 64;
const icoPng = await sharp(SRC)
  .extract(markCrop)
  .resize(ICO_SIZE, ICO_SIZE)
  .ensureAlpha()
  .png()
  .toBuffer();
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);   // reserved
dir.writeUInt16LE(1, 2);   // 1 = icon
dir.writeUInt16LE(1, 4);   // one image
const entry = Buffer.alloc(16);
entry.writeUInt8(ICO_SIZE & 0xff, 0);
entry.writeUInt8(ICO_SIZE & 0xff, 1);
entry.writeUInt8(0, 2);            // palette size: 0 for truecolour
entry.writeUInt8(0, 3);            // reserved
entry.writeUInt16LE(1, 4);         // colour planes
entry.writeUInt16LE(32, 6);        // bits per pixel
entry.writeUInt32LE(icoPng.length, 8);
entry.writeUInt32LE(6 + 16, 12);   // payload starts after dir + entry
writeFileSync(path.join(root, "app", "favicon.ico"), Buffer.concat([dir, entry, icoPng]));
console.log(`  ${"app/favicon.ico".padEnd(28)} ${ICO_SIZE}×${ICO_SIZE}  (legacy tab icon)`);

console.log("\nDone. Commit the regenerated files in public/ and app/favicon.ico.");
