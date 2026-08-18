/* Three photos on every complaint, from either side.

   A complaint opens a dispute about someone's clothes and has to stand on its
   own weeks later. "There was a stain" proves nothing once the garment has
   been washed again — whichever side is right. Staff damage reports already
   required three; student complaints accepted none. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MIN_DAMAGE_PHOTOS, MAX_PHOTOS_PER_MESSAGE, cleanPhotos } from "../lib/complaint-rules";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const actions = read("lib/actions/complaints.ts");
const ui = read("app/c/help/_components/HelpClient.tsx");

describe("both sides are held to the same bar", () => {
  it("a student complaint requires the minimum", () => {
    const fn = actions.slice(actions.indexOf("export async function submitComplaint"));
    expect(fn).toMatch(/pics\.length < MIN_DAMAGE_PHOTOS/);
  });

  it("a staff damage report still requires it", () => {
    const fn = actions.slice(actions.indexOf("export async function reportOrderDamage"));
    expect(fn).toMatch(/pics\.length < MIN_DAMAGE_PHOTOS/);
  });

  it("both quote the same shared constant, not a hardcoded 3", () => {
    expect(actions).not.toMatch(/pics\.length < 3\b/);
    expect(MIN_DAMAGE_PHOTOS).toBe(3);
  });
});

describe("the server is the check that counts", () => {
  it("rejects server-side even though the button is disabled", () => {
    // a server action is a public endpoint; the UI is a convenience
    const fn = actions.slice(actions.indexOf("export async function submitComplaint"));
    const guardAt = fn.indexOf("pics.length < MIN_DAMAGE_PHOTOS");
    const createAt = fn.indexOf("db.complaint.create");
    expect(guardAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(guardAt); // guard runs BEFORE the write
  });

  it("says how many are still needed rather than just refusing", () => {
    expect(actions).toMatch(/so far\) — they are what settles the claim/);
  });
});

describe("the student is told before they type, not after", () => {
  it("the button counts down the remaining photos", () => {
    expect(ui).toMatch(/Add \$\{MIN_DAMAGE_PHOTOS - photos\.length\} more photo/);
  });

  it("submission is blocked until the bar is met", () => {
    expect(ui).toMatch(/photos\.length < MIN_DAMAGE_PHOTOS/);
    expect(ui).toMatch(/disabled=\{loading \|\| uploading \|\| photos\.length < MIN_DAMAGE_PHOTOS/);
  });

  it("explains WHY, so a disabled button is not a dead end", () => {
    expect(ui).toMatch(/cannot be photographed later/);
  });

  it("the cap leaves room above the minimum", () => {
    // the old hardcoded 6 has gone; a student may attach as many as staff can
    expect(ui).not.toMatch(/photos\.length >= 6/);
    expect(MAX_PHOTOS_PER_MESSAGE).toBeGreaterThan(MIN_DAMAGE_PHOTOS);
  });
});

describe("cleanPhotos", () => {
  it("drops blanks so three empty strings cannot pass the check", () => {
    expect(cleanPhotos(["", "  ", ""])).toEqual([]);
  });
  it("trims and keeps real keys", () => {
    expect(cleanPhotos([" a.jpg ", "b.jpg"])).toEqual(["a.jpg", "b.jpg"]);
  });
  it("caps the count", () => {
    expect(cleanPhotos(Array(99).fill("x.jpg")).length).toBe(MAX_PHOTOS_PER_MESSAGE);
  });
});
