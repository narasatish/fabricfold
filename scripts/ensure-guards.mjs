/* Make sure the ledger-immutability guards exist on whatever database we deploy
   against.

   The old Sydney database had these; Mumbai — the LIVE one — appeared to have
   none, meaning production was less protected than dev. A payment, invoice,
   credit note or audit row could be edited or deleted with nothing to stop it,
   which is precisely the thing an accounting trail must never allow.

   Runs on every deploy, right after the schema sync, and is idempotent. Running
   it each time also repairs the case where a schema change recreates a table
   and silently drops its trigger.

   There is a deliberate escape hatch: `SET app.allow_delete = 'on'` inside a
   transaction lets a genuine correction through. It's off unless explicitly
   set, so accidents are blocked while a real fix stays possible. */
import pg from "pg";

/* On Vercel the env vars are already in the process; locally they live in .env.
   Loading dotenv when present makes this script runnable by hand, which is what
   lets it be verified rather than assumed. */
try { (await import("dotenv")).config(); } catch { /* not installed: fine on Vercel */ }

const GUARDED = ["Payment", "Invoice", "CreditNote", "AuditLog"];

/* Value constraints the DATABASE enforces, not just the app.

   The security audit found these were app-guarded only: plain SQL could set a
   student's credits to -9999 or mark 99999 cycles used. Application validation
   is one bug away from being bypassed; a CHECK constraint is not. These are
   the invariants where being wrong means wrong money.

   Named ff_* so they are recognisable, and added only when the existing data
   already satisfies them — a deploy must never fail because of historical rows
   it cannot fix. */
const CHECKS = [
  ["Student", "ff_credits_not_negative", `"credits" >= 0`],
  ["Subscription", "ff_cycles_used_not_negative", `"cyclesUsed" >= 0`],
  ["Subscription", "ff_cycles_used_within_total", `"cyclesUsed" <= "cyclesTotal"`],
  ["Order", "ff_total_not_negative", `"total" >= 0`],
  ["Order", "ff_surcharge_not_negative", `"surcharge" >= 0`],
  ["Bag", "ff_bag_price_not_negative", `"price" >= 0`],
];

const FN = `
CREATE OR REPLACE FUNCTION public.ff_protect_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.allow_delete', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'FabricFold: % on % is not allowed — financial records are immutable', TG_OP, TG_TABLE_NAME
    USING HINT = 'Ledger rows can only be corrected by new entries (refunds / credit notes), never edited or deleted.';
END;
$function$`;

const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.log("[guards] No Postgres URL — skipping.");
  process.exit(0);
}

const host = (url.match(/@([^/?]+)/) || [])[1] || "unknown";
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  await client.query(FN);

  let added = 0, already = 0, absent = 0;
  for (const table of GUARDED) {
    const exists = await client.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [table]);
    if (!exists.rowCount) { absent++; console.log(`[guards] ${table}: table not present, skipped`); continue; }

    const had = await client.query(
      `select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
       where not t.tgisinternal and n.nspname='public' and c.relname=$1 and t.tgname='ff_protect'`, [table]);

    // Drop-then-create rather than "if missing": guarantees the definition
    // matches this file even if an older variant is installed.
    await client.query(`DROP TRIGGER IF EXISTS ff_protect ON public."${table}"`);
    await client.query(
      `CREATE TRIGGER ff_protect BEFORE DELETE OR UPDATE ON public."${table}"
       FOR EACH ROW EXECUTE FUNCTION ff_protect_ledger()`);

    if (had.rowCount) already++; else { added++; console.log(`[guards] ${table}: guard ADDED`); }
  }
  console.log(`[guards] ${host} — ${added} added, ${already} already present, ${absent} skipped`);

  /* Installing a trigger and having it actually STOP a write are different
     claims. A trigger can exist and still protect nothing — wrong events, a
     function that returns instead of raising. So attempt a real UPDATE inside
     a transaction that is always rolled back, and fail the build if it goes
     through. "The installer said OK" is not evidence. */
  let verified = 0, unverifiable = 0;
  for (const table of GUARDED) {
    const rows = await client.query(`select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name=$1`, [table]);
    if (!rows.rowCount || !rows.rows[0].n) continue;

    const any = await client.query(`select count(*)::int n from "${table}"`);
    if (!any.rows[0].n) { unverifiable++; continue; } // nothing to attempt against

    await client.query("BEGIN");
    let blocked = false;
    try {
      await client.query(`UPDATE "${table}" SET id = id WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`);
    } catch {
      blocked = true;
    }
    await client.query("ROLLBACK"); // nothing is ever committed either way

    if (!blocked) {
      console.error(`[guards] VERIFY FAILED: an UPDATE on ${table} was NOT blocked.`);
      process.exit(1);
    }
    verified++;
  }
  console.log(
    `[guards] verified ${verified} table(s) actually reject writes` +
      (unverifiable ? `; ${unverifiable} empty, nothing to attempt against` : ""),
  );

  /* Value constraints. Added only where current data already complies —
     failing a deploy over historical rows would mean the safest change is the
     one nobody can ship. A violation is reported loudly instead. */
  let checksAdded = 0, checksPresent = 0, checksSkipped = 0;
  for (const [table, name, expr] of CHECKS) {
    const exists = await client.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [table]);
    if (!exists.rowCount) continue;

    const has = await client.query(
      // $2::text — Postgres cannot infer a parameter's type inside format()
      `select 1 from pg_constraint where conname = $1 and conrelid = format('public.%I', $2::text)::regclass`,
      [name, table]);
    if (has.rowCount) { checksPresent++; continue; }

    const bad = await client.query(`select count(*)::int n from public."${table}" where NOT (${expr})`);
    if (bad.rows[0].n > 0) {
      console.warn(`[guards] ${table}.${name}: ${bad.rows[0].n} existing row(s) violate ${expr} — constraint NOT added, investigate`);
      checksSkipped++;
      continue;
    }
    await client.query(`ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" CHECK (${expr})`);
    console.log(`[guards] ${table}.${name}: constraint ADDED`);
    checksAdded++;
  }
  console.log(
    `[guards] value constraints — ${checksAdded} added, ${checksPresent} already present` +
      (checksSkipped ? `, ${checksSkipped} SKIPPED due to existing bad data` : ""),
  );

  /* One customer ID, one student — enforced by the DATABASE.

     A bag code is recycled when a student leaves, so `code` cannot be globally
     unique any more: B001 legitimately appears on several rows over the years.
     What must never happen is two students holding B001 AT ONCE, which a bug
     in the allocator could otherwise cause silently — and the damage lands on
     a physical bag handed to the wrong person.

     Prisma cannot express a partial unique index, so it is created here.
     Released rows are excluded; everything still in service is unique.

     Schema-aware, unlike the rest of this file: the isolated `ff_test` schema
     the suite runs against needs the same index, or a test asserting "the DB
     rejects a duplicate code" would pass in production and quietly prove
     nothing where it actually runs. FF_GUARD_SCHEMA=ff_test targets it. */
  const SCHEMA = process.env.FF_GUARD_SCHEMA || "public";

  /* One payment per order per method — enforced by the DATABASE.

     Both payment paths check `paid` before writing, and neither check can win
     a race. Postgres runs READ COMMITTED, so two concurrent transactions both
     read paid = false and both insert; the Razorpay webhook is worse, because
     its check sits OUTSIDE the transaction and Razorpay retries deliveries.
     Two retries arriving together charge a student twice.

     That is not a bug you can clean up afterwards: Payment rows are immutable
     by trigger, so a duplicate cannot be deleted, only offset with a manual
     credit note after the money has already left.

     Two indexes:
       gatewayRef  — one Razorpay payment id may appear once, full stop. This
                     is what makes webhook retries safe.
       order+method — an order may hold a `credit` row AND a `upi` row (the
                     split payCore writes), but never two of the same method.
                     Refunds and cash_out are excluded: an order can legitimately
                     be refunded more than once. */
  const payTable = await client.query(
    `select 1 from information_schema.tables where table_schema=$1 and table_name='Payment'`, [SCHEMA]);
  if (payTable.rowCount) {
    const payIdx = [
      ["payment_gateway_ref_uniq", `("gatewayRef") WHERE "gatewayRef" IS NOT NULL`,
        `select count(*)::int n from (select "gatewayRef" from "${SCHEMA}"."Payment"
           where "gatewayRef" is not null group by "gatewayRef" having count(*) > 1) d`],
      ["payment_order_method_uniq", `("orderId", method) WHERE "orderId" IS NOT NULL AND method NOT IN ('refund','cash_out')`,
        `select count(*)::int n from (select "orderId", method from "${SCHEMA}"."Payment"
           where "orderId" is not null and method not in ('refund','cash_out')
           group by "orderId", method having count(*) > 1) d`],
    ];
    for (const [name, def, dupeSql] of payIdx) {
      const has = await client.query(
        `select 1 from pg_indexes where schemaname=$1 and indexname=$2`, [SCHEMA, name]);
      if (has.rowCount) { console.log(`[guards] ${SCHEMA}.Payment.${name}: already present`); continue; }
      // Same rule as everywhere else: report bad data, never fail the deploy.
      const dupes = await client.query(dupeSql);
      if (dupes.rows[0].n > 0) {
        console.warn(`[guards] ${SCHEMA}.Payment.${name}: ${dupes.rows[0].n} duplicate group(s) already exist — index NOT added, investigate before real money flows`);
        continue;
      }
      await client.query(`CREATE UNIQUE INDEX "${name}" ON "${SCHEMA}"."Payment"${def}`);
      console.log(`[guards] ${SCHEMA}.Payment.${name}: index ADDED`);
    }
  }

  /* One offline intake, one order.

     An order captured while the counter had no connection is replayed later,
     and the replay can fire more than once — the tab reconnects and the staff
     member also taps retry, or a request times out after the server already
     committed. Without this the student's clothes are booked in twice and the
     counter has two tickets for one bag. */
  const orderTable = await client.query(
    `select 1 from information_schema.tables where table_schema=$1 and table_name='Order'`, [SCHEMA]);
  if (orderTable.rowCount) {
    const oIdx = "order_idem_key_uniq";
    const hasO = await client.query(
      `select 1 from pg_indexes where schemaname=$1 and indexname=$2`, [SCHEMA, oIdx]);
    if (hasO.rowCount) {
      console.log(`[guards] ${SCHEMA}.Order.${oIdx}: already present`);
    } else {
      const dupes = await client.query(
        `select count(*)::int n from (select "idemKey" from "${SCHEMA}"."Order"
           where "idemKey" is not null group by "idemKey" having count(*) > 1) d`);
      if (dupes.rows[0].n > 0) {
        console.warn(`[guards] ${SCHEMA}.Order.${oIdx}: ${dupes.rows[0].n} duplicate key(s) — index NOT added, investigate`);
      } else {
        await client.query(
          `CREATE UNIQUE INDEX "${oIdx}" ON "${SCHEMA}"."Order"("idemKey") WHERE "idemKey" IS NOT NULL`);
        console.log(`[guards] ${SCHEMA}.Order.${oIdx}: index ADDED`);
      }
    }
  }

  const bagTable = await client.query(
    `select 1 from information_schema.tables where table_schema=$1 and table_name='Bag'`, [SCHEMA]);
  if (bagTable.rowCount) {
    const idx = "bag_code_in_service_uniq";
    const hasIdx = await client.query(
      `select 1 from pg_indexes where schemaname=$1 and indexname=$2`, [SCHEMA, idx]);
    if (hasIdx.rowCount) {
      console.log(`[guards] ${SCHEMA}.Bag.${idx}: already present`);
    } else {
      // Same rule as the CHECKs: report bad data rather than fail the deploy.
      const dupes = await client.query(
        `select count(*)::int n from (
           select code from "${SCHEMA}"."Bag" where status <> 'released'
           group by code having count(*) > 1
         ) d`);
      if (dupes.rows[0].n > 0) {
        console.warn(`[guards] ${SCHEMA}.Bag.${idx}: ${dupes.rows[0].n} code(s) already held by two live bags — index NOT added, investigate`);
      } else {
        await client.query(
          `CREATE UNIQUE INDEX "${idx}" ON "${SCHEMA}"."Bag"(code) WHERE status <> 'released'`);
        console.log(`[guards] ${SCHEMA}.Bag.${idx}: index ADDED`);
      }
    }
  }
} catch (e) {
  // A deploy without ledger protection is worse than no deploy: fail the build
  // and leave the previous deployment live.
  console.error(`[guards] FAILED on ${host}: ${e.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
