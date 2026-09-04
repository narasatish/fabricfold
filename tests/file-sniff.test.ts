/* Upload routes trusted `file.type` — the browser's Content-Type guess,
   fully controlled by whoever is uploading — as proof of what a file
   actually is. A renamed file with a ".jpg" extension sailed straight
   through. sniffMatchesType checks the real magic bytes instead. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sniffMatchesType } from "../lib/file-sniff";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("sniffMatchesType", () => {
  it("accepts a real JPEG claiming to be one", () => {
    expect(sniffMatchesType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), "image/jpeg")).toBe(true);
  });
  it("accepts a real PNG claiming to be one", () => {
    expect(sniffMatchesType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "image/png")).toBe(true);
  });
  it("accepts a real WEBP claiming to be one", () => {
    const b = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
    expect(sniffMatchesType(b, "image/webp")).toBe(true);
  });
  it("accepts a real PDF claiming to be one", () => {
    expect(sniffMatchesType(Buffer.from("%PDF-1.7\n..."), "application/pdf")).toBe(true);
  });
  it("rejects a file whose bytes don't match what it claims to be — the whole point", () => {
    // a plain text/script file renamed to look like a jpeg
    const notAJpeg = Buffer.from("<?php system($_GET['c']); ?>");
    expect(sniffMatchesType(notAJpeg, "image/jpeg")).toBe(false);
  });
  it("rejects an unrecognised claimed type outright — never trust what it can't check", () => {
    expect(sniffMatchesType(Buffer.from([0xff, 0xd8, 0xff]), "application/octet-stream")).toBe(false);
  });
});

describe("every upload route checks it, after reading the bytes and before storing them", () => {
  for (const route of ["app/api/upload/intake/route.ts", "app/api/upload/complaint/route.ts", "app/api/upload/receipt/route.ts"]) {
    it(route, () => {
      const src = read(route);
      expect(src).toMatch(/import \{ sniffMatchesType \} from "@\/lib\/file-sniff"/);
      expect(src).toMatch(/if \(!sniffMatchesType\(bytes, file\.type\)\) return new Response\("file content doesn't match its type", \{ status: 415 \}\);/);
    });
  }
});
