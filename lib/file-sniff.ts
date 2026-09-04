/**
 * Verifies a file's ACTUAL content matches the MIME type it claims — the
 * `file.type` an upload route checks otherwise comes straight from the
 * browser's Content-Type guess (usually the file extension), which the
 * uploader fully controls. A renamed executable or script with a
 * ".jpg"/".png" extension sails through a type-string check; it can't fake
 * the first few bytes of a real JPEG/PNG/WEBP/PDF without actually being one.
 *
 * Not a full format validator (a crafted-but-technically-valid JPEG could
 * still carry a payload for some downstream parser) — but it closes the
 * cheap, common case: an upload whose content doesn't match its claimed
 * type at all.
 */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  "application/pdf": (b) => b.length >= 5 && b.subarray(0, 5).toString("ascii") === "%PDF-",
};

export function sniffMatchesType(bytes: Buffer, claimedType: string): boolean {
  const check = SIGNATURES[claimedType];
  return check ? check(bytes) : false; // unknown type: never trust it
}
