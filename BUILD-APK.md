# Putting FabricFold on a phone

FabricFold is one deployment serving two apps:

| App | URL | Manifest |
|-----|-----|----------|
| Customer (students) | `https://fabricfold.in/c` | `/manifest.webmanifest` |
| Staff (counter) | `https://fabricfold.in/s` | `/staff.webmanifest` |

They are **separate installs**. Each manifest has its own `id` and `start_url`,
so Android treats them as two apps and a student never lands on the counter
screen. Install or package them one at a time, using the URL from the table.

---

## 1) Install it today — no build, no account (start here)

On the phone:

1. Open the app's URL in **Chrome** (`/c` for students, `/s` for staff).
2. Menu (⋮) → **Add to Home screen** / **Install app**.
3. It installs with the FabricFold icon and opens full-screen.

This is instant and **auto-updates on every deploy** — no reinstall, no store
review. For counter phones this is usually all you need, and it is the right
answer while pricing and flows are still changing.

---

## 2) A real APK / Play Store package — PWABuilder

Use this when you need a file to send someone, or a Play Store listing.

1. Go to **https://www.pwabuilder.com**
2. Enter the URL — **`https://fabricfold.in/s`** for the staff app.
3. **Package for stores → Android**.
4. Download either:
   - **APK** — sideload it. The phone must allow "install unknown apps".
   - **AAB** — upload to Google Play Console.

PWABuilder generates the icon sizes from the manifest and signs the test build
for you. It produces a **Trusted Web Activity**: a thin native wrapper around
the live site, which is Google's recommended way to ship a PWA.

Two things to know before you rely on it:

- A Play Store developer account is a **one-time $25**.
- **Keep the signing key it gives you.** Play ties an app's identity to that
  key — lose it and you cannot update the listing, only publish a new one under
  a different name, abandoning your installs and reviews. Back it up somewhere
  that is not this laptop.

Because a TWA loads the live site, a deploy updates the installed app too. You
only rebuild the package when the icon, name or start URL changes.

---

## 3) Capacitor — only when you need native hardware

`capacitor.config.json` is committed with `appId` **`in.fabricfold.staff`**,
carried over from the earlier Firebase build so the app identity stays the same
if you ever publish. It currently points at the live `/s` URL, so it behaves
like the TWA above.

This route exists for one reason: **native Bluetooth thermal printing** for
garment tags, which a TWA cannot do. Web Bluetooth is not available inside a
Trusted Web Activity, so tag printing needs a real native shell.

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap add android
npx cap sync
npx cap open android      # Android Studio → Build > Build APK
```

**This needs Android Studio and a JDK on the build machine.** Neither is
installed here — `java`, `gradle` and `adb` are all absent and there is no
Android SDK — so the APK cannot be produced in this environment. Options 1 and
2 need nothing installed, which is why they come first.

For offline use or Bluetooth printing later: drop `server.url` from the config,
add `@capacitor-community/bluetooth-le`, and ship a built bundle instead of
loading the live site. That turns the app into something you must redeploy to
update, so only do it when the hardware requires it.

---

## Before packaging, check the PWA is sound

The package is generated **from the live site**, so anything wrong there ends up
baked into the APK. Deploy first, then confirm:

```bash
curl -s https://fabricfold.in/staff.webmanifest
```

- both manifests return 200 and parse as JSON
- icons resolve (`/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`)
- the service worker registers — bump `CACHE_VERSION` in `public/sw.js` on
  every deploy or installed apps keep serving the old shell
