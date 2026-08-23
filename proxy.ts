/* Route boundary between the two apps — Next.js 16 proxy (the file formerly
   known as middleware.ts).

   DEFENCE IN DEPTH, not the only lock. Every /s page checks the session
   server-side and every staff server action calls requireStaff() against the
   database — a student could not read staff data even without this file. What
   this adds is a single choke point: a student who types /s/reports into the
   URL bar is turned around before ANY staff code runs, and a future staff page
   whose author forgets the per-page check is still covered.

   Deliberately reads only the signed cookie — no database here. The proxy runs
   on every matched request, and role/active/epoch are re-verified in
   requireStaff anyway; duplicating those DB reads at the edge would double the
   query load for zero extra safety. A forged cookie fails the signature check
   and is treated as no session at all. */
import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret");

async function sessionMode(req: NextRequest): Promise<"customer" | "staff" | null> {
  const tok = req.cookies.get("ff_session")?.value;
  if (!tok) return null;
  try {
    const { payload } = await jwtVerify(tok, SECRET);
    return payload.mode === "staff" ? "staff" : payload.mode === "customer" ? "customer" : null;
  } catch {
    return null; // expired or tampered — same as not signed in
  }
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const mode = await sessionMode(req);

  // A student on a staff URL goes home; no session goes to sign-in.
  if (path.startsWith("/s")) {
    if (mode === "customer") return NextResponse.redirect(new URL("/c", req.url));
    if (!mode) return NextResponse.redirect(new URL("/login", req.url));
  }

  // Staff on a customer URL likewise — the counter phone should never wander
  // into a student's view of the app.
  if (path.startsWith("/c")) {
    if (mode === "staff") return NextResponse.redirect(new URL("/s", req.url));
    if (!mode) return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}

export const config = {
  /* Only the two apps. The marketing site, /login and /api stay out of the
     proxy entirely — API routes carry their own session checks, and matching
     them here would add a JWT verify to every poll for nothing. */
  matcher: ["/s/:path*", "/c/:path*"],
};
