# Session handoff — FabricFold production app

## Status: COMPLETE & VERIFIED (all committed, git log tells the story)
E2E verified in browser: OTP login (both apps) → draft order → staff verify/accept (QR garment tags) → UPI pay → GST invoice INV-2627-0001 auto-created (₹75+₹14=₹89) → processing → ready (pickup OTP notif to student) → collected. Reports reconcile to the rupee. 8/8 vitest money-path tests green. Zero console errors.

## Architecture
- lib/db.ts (Prisma singleton), lib/auth.ts (JWT cookie ff_session, requireStudent/requireStaff(minRole), roles 1 Counter/2 Manager/3 Admin/4 Owner)
- lib/money.ts (EXPRESS_PCT=0.4 → expressSurcharge(subtotal)=40% of order value, flat all colleges; financialYearTag, nextInvoiceNo/nextCreditNoteNo via FySequence tx, createInvoice, createCreditNote proportional, shouldInvoice, orderDueAt/isOverdue = received+(express?1:2)d, loyaltyTier 50/150)
- lib/actions/* = ALL mutations (server actions): auth, orders (place/accept/advance/collect/payCore credit-split/recordPay staffInvoice override/refund/redo/cancel/rate/scanTag), credits (compensation; cash=Manager+, posts cash_out+CN), subscription (request/activate Manager+ w/ cash OTP), complaints (chat threads), admin (rates/plan/payment/settings/toggleFeature Manager+/college Owner-only/staff/expense Manager+/payslip Admin+ w/ auto Salaries expense)
- lib/report.ts: parsePeriod + computeReport (drawer = float+cash−cashRefunds−cashOut−cashExpenses; netGst = collected−cnGst) + reportText (daily email)
- Realtime: lib/realtime.ts EventEmitter bus → SSE /api/rt (channels student:{id}, orders:{collegeId}); components/chrome.tsx RealtimeRefresh
- API routes: /api/rt, /api/razorpay/webhook (payment.captured→invoice, needs RAZORPAY_WEBHOOK_SECRET), /api/export/xlsx?type=full|transactions|gst|expenses (exceljs), /api/export/invoice/[orderId] (printable HTML), /api/export/statement, /api/report/daily (POST staff / GET cron w/ CRON_SECRET; vercel.json 9PM IST), /api/upload/receipt (Supabase Storage or public/uploads dev fallback), /api/receipt?key=, /api/push/subscribe
- components/: chrome.tsx (AppShell/toast/TopBar/TabBar/Sheet/Seg/Switch/useRealtime), icons.tsx (IC map), qr.tsx (QR gen port), pwa.tsx (SW+push, VAPID via scripts/vapid.ts)
- Seed mirrors prototype: 2 colleges (St Mary's, BVRIT w/ per-college features Json), 4 students (482913 Aarav has sub 12/34 used + ₹250 credits), 4 staff, 7 orders

## Pending (user inputs needed)
1. Supabase (USER CHOSE over Firebase — Firebase rejected: no SQL, storage needs Blaze): user creates project → connection string + service key → npm i @prisma/adapter-pg, schema provider postgresql, swap adapter in lib/db.ts, migrate deploy + seed, bucket "receipts". README has steps.
2. Razorpay keys; real SMS provider (sendSms stub in lib/actions/auth.ts); Vercel deploy (needs explicit user OK per their global rules).

## Gotchas learned
- .env DATABASE_URL must be ABSOLUTE file path (dev server cwd ≠ project root).
- preview_fill doesn't trigger React state — use native setter + input event via preview_eval.
- Prisma 7: no url in schema; prisma.config.ts + driver adapters; `prisma db push --url`.
- User's global CLAUDE.md rules apply: QA-check diffs via fast haiku agent before reporting; no production deploys without per-deploy OK.

## Wider context (outside this repo)
- Older PWA (campus-laundry/app.html → customer+staff builds) still live at fabricfold.web.app / fabricfold-staff.web.app (Firebase Spark). Marketing site fabricfold-web.web.app. Owner phone 8019121966.
- Consultant brief: campus-laundry-app/docs/FabricFold-Consultant-Brief.md.
- Rates: Wash&Iron ₹15 (bedsheet ₹25); Iron: shirt/tee/pant 10, ladies top 15, saree 30, pyjama/blouse/dupatta 10; DryClean: shirt/pant/tee 100, ladies top 129, pyjama 70, dupatta 60, blouse 60/100/140, shoes 350. All +18% GST. Annual sub ₹6800+GST=₹8024, 34 cycles × 7kg, 1 drop=1 cycle.
