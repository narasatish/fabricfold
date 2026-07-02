# FabricFold — Campus Laundry & Dry-Clean Platform

Production realtime web app (customer + staff/admin), built from the design
handoff prototype (`FabricFold.html` — pixel-accurate source of truth for UI,
copy, dark mode and every business rule).

## Stack
- **Next.js 16** (App Router) + TypeScript, React 19
- **Prisma 7** — SQLite in dev, **Supabase Postgres** in production
- **SSE realtime** (`/api/rt`) — staff actions appear on the customer's open app within a second
- **Phone-OTP auth** (DEV_OTP console fallback), roles 1–4 enforced server-side
- **PWA** (installable, offline shell) + **Web Push**
- **Razorpay webhook** auto-confirmation (manual UPI QR + cash fallbacks)
- **exceljs** GST-ready exports; **Supabase Storage** for expense receipts
- **vitest** money-path tests

## Run locally
```bash
npm install
npx prisma migrate dev   # creates dev.db
npm run seed             # demo data (2 colleges, 4 students, staff, orders)
npm run dev              # http://localhost:3000
```
Login: any seeded phone (e.g. customer 9876500011, owner 8019121966) — dev OTP is **123456**.

## Test
```bash
npm test   # GST split, invoice numbering, refund credit notes, credit split, drawer math
```

## Switch to Supabase (production DB + storage)
1. Create a free project at supabase.com → copy the **connection string** and a **service role key**.
2. `npm i @prisma/adapter-pg` ; in `prisma/schema.prisma` set `provider = "postgresql"`;
   in `lib/db.ts` swap `PrismaBetterSqlite3` for `PrismaPg` (same one-line shape).
3. Set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` in `.env` / Vercel.
4. `npx prisma migrate deploy && npm run seed`.
5. Create a private storage bucket named `receipts`.

## Deploy (Vercel free)
- Import the repo, set env vars from `.env.example` (incl. `CRON_SECRET`).
- `vercel.json` schedules the daily 9 PM IST owner report.
- Point the Razorpay webhook (payment.captured) at `/api/razorpay/webhook`.

## Business rules (see docs/ handoff README for the full list)
- Prices GST-inclusive; **UPI ⇒ auto GST invoice**, cash ⇒ only with staff
  override, credit-only ⇒ never. Per-FY numbering `INV-<FY>-0001` via a
  transactional sequence (no gaps).
- Refunds raise **proportional credit notes**; cash compensation posts
  `cash_out` + credit note.
- Store credit split-pays bills; every redemption dated.
- Subscriptions are cycle-based (34 × 7 kg) with a dated cycle log.
- SLA due = received + (express ? 1 : 2) days; overdue badges + report averages.
- Cash-drawer: opening float + cash − cash refunds − payouts − cash expenses.
