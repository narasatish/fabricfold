# FabricFold (production app)

Campus laundry platform. Customer app `/c` + staff app `/s`. Read `HANDOFF.md` before non-trivial work.

- Stack: Next.js 16 (async cookies/params, Turbopack) + TS + Prisma 7. LIVE on Render's own native Postgres (`fabricfold-db`, provisioned + bound via `render.yaml`'s `fromDatabase`, Singapore region) — self-contained, not shared with anything else. Supabase (Mumbai project vhwjdnjsruuarcoqduuu) and Vercel are both kept alive per owner's choice but serve NO live database traffic; Supabase's only remaining live role is file storage (`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`SUPABASE_BUCKET` for complaint/receipt photo uploads). See docs/claude-playbook.md "Infrastructure reality" for the full history — this line was wrong for a while after the Render migration; don't re-introduce that mistake. lib/db.ts + seed.ts auto-pick the adapter from DATABASE_URL: postgres:// → PrismaPg (prod), file: → better-sqlite3 (legacy dev). Schema provider is postgresql. Money tests run in an isolated `ff_test` schema on the same DB.
- Copy/business rules: the prototype `C:\Users\naras\Downloads\ff_design\design_handoff_fabricfold\FabricFold.html` + its README. UI is now design-system v2 (owner-approved restyle, Jul 2026): tokens + motion system live in app/globals.css — keep the class contract, don't reintroduce prototype-flat styles.
- Money rules are sacred: GST is payment-method driven (UPI→invoice, cash only w/ staff override, credit never); per-FY gap-free numbering via FySequence; refunds→proportional credit notes. Tests: `npm test` (must stay green).
- Never pass Prisma objects (Decimal) to client components — serialize to plain numbers in the page.
- Dev login: customer 9876500011 / owner 8019121966, OTP 123456. The owner number is BOTH staff and student (separate tables, separate unique keys) so the customer app can be tested from the counter phone — student id 801966. Run: `npm run dev` (port 3005 via ../.claude/launch.json). Reseed: `npm run seed`.
- Commit per step; never commit .env/secrets. Deploy only with explicit user OK.


# This is NOT the Next.js you know
This Next.js version has breaking changes vs training data. Read node_modules/next/dist/docs/ guides before writing framework code (async cookies/params, Turbopack default, proxy not middleware).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
