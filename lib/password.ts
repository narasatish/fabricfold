/* Passcode hashing.

   scrypt from Node's own crypto — no dependency to audit, and it is a memory-
   hard KDF, so a stolen database cannot be cracked at GPU speed the way plain
   SHA-256 could.

   A passcode is NEVER stored or logged. What is stored is a salted hash and
   the salt; the original cannot be recovered from either, which is the point:
   nobody at FabricFold, including whoever runs the database, can read a
   student's passcode.

   Comparison is timing-safe. A naive === leaks how much of the hash matched,
   which over many attempts narrows the search. */
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

/** Minimum length. Short enough for a phone keypad, long enough to matter
    given the lockout below. */
export const MIN_PASSCODE = 4;
export const MAX_PASSCODE = 64;

/** Wrong attempts before the account locks, and for how long. Without this a
    4-digit passcode is 10,000 guesses — seconds of scripted attempts. */
export const MAX_PW_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;

export function passcodeProblem(passcode: string): string | null {
  const p = (passcode || "").trim();
  if (p.length < MIN_PASSCODE) return `Passcode must be at least ${MIN_PASSCODE} characters`;
  if (p.length > MAX_PASSCODE) return `Passcode must be ${MAX_PASSCODE} characters or fewer`;
  // Sequences and repeats are the first things anyone guesses.
  if (/^(\d)\1+$/.test(p)) return "Passcode can't be the same digit repeated";
  if (["1234", "12345", "123456", "0000", "1111"].includes(p)) return "That passcode is too easy to guess";
  return null;
}

export async function hashPasscode(passcode: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(passcode, salt, KEYLEN)).toString("hex");
  return { hash, salt };
}

export async function verifyPasscode(passcode: string, hash: string | null, salt: string | null) {
  if (!hash || !salt) return false;
  const candidate = await scrypt(passcode, salt, KEYLEN);
  const stored = Buffer.from(hash, "hex");
  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

/** Minutes remaining on a lockout, or 0 if not locked. */
export function lockoutMinutesLeft(lockedUntil: Date | null) {
  if (!lockedUntil) return 0;
  const ms = lockedUntil.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}
