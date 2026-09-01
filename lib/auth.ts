import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { db } from "./db";

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret");
const COOKIE = "ff_session";

export type Session =
  | { mode: "customer"; studentId: string; epoch?: number }
  | { mode: "staff"; staffId: string; role: number; epoch?: number };

export async function createSession(s: Session) {
  const jwt = await new SignJWT(s as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(SECRET);
  const jar = await cookies();
  jar.set(COOKIE, jwt, {
    httpOnly: true,               // JS on the page can never read the session
    sameSite: "lax",              // not sent on cross-site POSTs (CSRF hardening)
    secure: process.env.NODE_ENV === "production", // HTTPS-only in production
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  try {
    const jar = await cookies();
    const tok = jar.get(COOKIE)?.value;
    if (!tok) return null;
    const { payload } = await jwtVerify(tok, SECRET);
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

export async function requireStudent() {
  const s = await getSession();
  if (!s || s.mode !== "customer") throw new AuthError("Not signed in");
  const stu = await db.student.findUnique({ where: { id: s.studentId }, include: { subscription: true, college: true } });
  if (!stu) throw new AuthError("Account not found");
  /* Revocation check. Free: this row was loaded anyway. A token issued before
     the last "sign out everywhere" carries a stale epoch and is refused, which
     is what makes that button mean something. Tokens predating the feature
     have no epoch and are treated as epoch 0, so nobody is logged out by the
     upgrade itself. */
  if ((s.epoch ?? 0) !== stu.sessionEpoch) throw new AuthError("Session ended — please sign in again");
  return stu;
}

/** Role levels: 1 Counter · 2 Manager · 3 Admin · 4 Owner — enforced HERE, server-side. */
export async function requireStaff(minRole = 1) {
  const s = await getSession();
  if (!s || s.mode !== "staff") throw new AuthError("Not signed in");
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!st) throw new AuthError("Account not found");
  /* Checked on EVERY request, not just at sign-in. Deactivation bumps the
     epoch too, but this is the backstop: a removed staff member must lose
     access mid-session, not whenever their token happens to expire. */
  if (!st.active) throw new AuthError("This staff account has been removed");
  if ((s.epoch ?? 0) !== st.sessionEpoch) throw new AuthError("Session ended — please sign in again");
  /* Role is read from the DATABASE, never from the token. A demoted staff
     member holding an old token must not keep Admin rights until it expires. */
  if (st.role < minRole) throw new AuthError("Not allowed for your role");
  return st;
}

/**
 * The session, but only if the account behind it can still sign in.
 *
 * getSession() answers "is the cookie validly signed?". That is not the same
 * as "may this person use the app": the staff row may have been removed, or
 * "sign out everywhere" may have bumped the epoch. Screens that decide where
 * to SEND someone (the login page, the two app layouts) need this stronger
 * question — otherwise a dead cookie bounces /login → /s → error → /login,
 * and the person is stuck until they clear cookies by hand.
 */
export async function liveSession(): Promise<Session | null> {
  const s = await getSession();
  if (!s) return null;
  try {
    if (s.mode === "staff") await requireStaff(1);
    else await requireStudent();
    return s;
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}

/** requireStaff + a named-tool check. The tool gate sits on top of the role
    floor, so a revoked manager is refused here even though their role would
    have passed — and a granted counter member gets through. */
export async function requireStaffPerm(key: import("./perms").PermKey) {
  const st = await requireStaff(1);
  const { staffCan, PERM_DEFS } = await import("./perms");
  if (!staffCan(st, key)) throw new AuthError(`Your account doesn't have "${PERM_DEFS[key].label}" — ask the owner`);
  return st;
}

export class AuthError extends Error {
  status = 401;
}
