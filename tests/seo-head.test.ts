/* Head tags on the indexed pages.

   The pipeline had no SEO step at all, so this whole class of defect was
   invisible to it: every check was green while the homepage — the single
   most-shared URL — had no og:image, and /login sat in the sitemap with no
   canonical. Both were found by counting tags on the live site, not by any
   test, which is why these exist now.

   Static assertions on the source. They cannot prove what a crawler receives
   (see the sitemap sweep for that), but they do catch the two mistakes that
   actually happened: forgetting a field, and assuming metadata merges. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

/** Pages listed in the sitemap that own their metadata. */
const INDEXED = [
  "app/page.tsx",
  "app/how-it-works/page.tsx",
  "app/hostel-laundry/page.tsx",
  "app/partners/page.tsx",
  "app/about/page.tsx",
  "app/contact/page.tsx",
  "app/login/page.tsx",
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
  "app/refunds/page.tsx",
];

describe("every indexed page is self-describing", () => {
  it.each(INDEXED)("%s declares a canonical", (p) => {
    // a sitemap entry without one invites the crawler to pick its own
    expect(read(p)).toMatch(/alternates:\s*\{\s*canonical:/);
  });

  it.each(INDEXED)("%s declares a title and description", (p) => {
    const src = read(p);
    expect(src).toMatch(/title:/);
    expect(src).toMatch(/description:/);
  });
});

describe("openGraph replaces, it does not merge", () => {
  /* The trap: the root layout sets openGraph.images site-wide, but any page
     declaring its own `openGraph` object REPLACES that object entirely. A page
     that sets a custom og title and forgets images silently loses the preview
     image, and nothing errors. */
  const pagesWithOwnOg = INDEXED.filter((p) => /openGraph:\s*\{/.test(read(p)));

  it("at least one page declares its own openGraph (guards this test)", () => {
    expect(pagesWithOwnOg.length).toBeGreaterThan(0);
  });

  it.each(pagesWithOwnOg)("%s repeats images in its own openGraph", (p) => {
    const src = read(p);
    const og = src.slice(src.indexOf("openGraph:"));
    expect(og).toMatch(/images:/);
  });
});

describe("the site-wide defaults exist to be inherited", () => {
  const layout = read("app/layout.tsx");

  it("the root layout supplies og and twitter images", () => {
    expect(layout).toMatch(/openGraph:/);
    expect(layout).toMatch(/images:\s*\[\{\s*url:\s*"\/og\.png"/);
    expect(layout).toMatch(/twitter:/);
    expect(layout).toMatch(/summary_large_image/);
  });

  it("metadataBase is set, so relative image paths resolve absolutely", () => {
    // without it Open Graph emits a relative URL and scrapers cannot fetch it
    expect(layout).toMatch(/metadataBase:\s*new URL\("https:\/\/fabricfold\.in"\)/);
  });
});

describe("sitemap and canonicals agree", () => {
  it("every indexed page above appears in the sitemap generator", () => {
    // a page canonicalised but unlisted, or listed but uncanonicalised, is the
    // commonest way these two drift apart
    const sitemap = read("app/sitemap.ts");
    const routes = ["", "how-it-works", "hostel-laundry", "partners", "about", "contact", "login", "privacy", "terms", "refunds"];
    for (const r of routes) {
      expect(sitemap, `sitemap is missing /${r}`).toMatch(new RegExp(`["'\`/]${r}["'\`]|url:.*${r}`));
    }
  });
});
