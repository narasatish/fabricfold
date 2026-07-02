import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { db } from "./db";

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret");
const COOKIE = "ff_session";

export type Session =
  | { mode: "customer"; studentId: string }
  | { mode: "staff"; staffId: string; role: number };

export async function createSession(s: Session) {
  const jwt = await new SignJWT(s as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("30d")
    .sign(SECRET);
  const jar = await cookies();
  jar.set(COOKIE, jwt, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
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
  return stu;
}

/** Role levels: 1 Counter · 2 Manager · 3 Admin · 4 Owner — enforced HERE, server-side. */
export async function requireStaff(minRole = 1) {
  const s = await getSession();
  if (!s || s.mode !== "staff") throw new AuthError("Not signed in");
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!st) throw new AuthError("Account not found");
  if (st.role < minRole) throw new AuthError("Not allowed for your role");
  return st;
}

export class AuthError extends Error {
  status = 401;
}
