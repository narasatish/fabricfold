# FabricFold (production app)

Campus laundry platform. Customer app `/c` + staff app `/s`. Read `HANDOFF.md` before non-trivial work.

- Stack: Next.js 16 (async cookies/params, Turbopack) + TS + Prisma 7 (SQLite dev via better-sqlite3 adapter; Supabase Postgres planned).
- Source of truth for UI/copy/business rules: the prototype `C:\Users\naras\Downloads\ff_design\design_handoff_fabricfold\FabricFold.html` + its README. Do NOT restyle; tokens live in app/globals.css.
- Money rules are sacred: GST is payment-method driven (UPI→invoice, cash only w/ staff override, credit never); per-FY gap-free numbering via FySequence; refunds→proportional credit notes. Tests: `npm test` (must stay green).
- Never pass Prisma objects (Decimal) to client components — serialize to plain numbers in the page.
- Dev login: customer 9876500011 / owner 8019121966, OTP 123456. Run: `npm run dev` (port 3005 via ../.claude/launch.json). Reseed: `npm run seed`.
- Commit per step; never commit .env/secrets. Deploy only with explicit user OK.


# This is NOT the Next.js you know
This Next.js version has breaking changes vs training data. Read node_modules/next/dist/docs/ guides before writing framework code (async cookies/params, Turbopack default, proxy not middleware).
