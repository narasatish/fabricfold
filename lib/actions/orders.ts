"use server";
/* Order lifecycle — business rules ported EXACTLY from the prototype.
   Every mutation: validate role -> write (transaction) -> audit where the
   prototype does -> realtime broadcast -> notification. */
import { db, dbSchemaPrefix } from "../db";
import { featureOn, serviceOn } from "../features";
import { enqueueSheetEvent, customerIdFor, istStamp, flushSoon } from "../sheet-events";
import { Prisma } from "../generated/prisma/client";
import { requireStudent, requireStaff, requireStaffPerm, assertSameCollege } from "../auth";
import { createInvoice, createCreditNote, shouldInvoiceOrder, computeBill, excessWeightCharge, CYCLE_KG_LIMIT, CYCLE_RATES, EXPRESS_FLAT, expressFlatFee, collegeExpressFee, isCycleService, collegeUsesCycleBasedPricing, resolveCollegeRates } from "../money";
import { assertSlotBookable } from "../slot-capacity";
import { publish, orderChannels } from "../realtime";
import { pushNotif, audit } from "../notify";
import { notifyOwner } from "../mail";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };
const orderCode = () => "FF" + rid(6);

type Rates = Record<string, { label: string; items: [string, number][] }>;
async function getConfig(collegeId?: string) {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  // gstEnabled: owner can turn GST billing off entirely (not mandatory for
  // unregistered businesses). Default ON for backwards compatibility.
  const gstEnabled = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
  // Per-garment QR tagging: parked for now (not in use), default OFF. Flip
  // settings.garmentTagsEnabled = true in Admin to bring it back — the
  // scanning UI on the staff order screen only renders when tags exist, so
  // turning this back on is the only step needed.
  const garmentTagsEnabled = (cfg.settings as Record<string, unknown>)?.garmentTagsEnabled === true;

  // Resolve rates: college override merged per-service over the global default.
  let rates = cfg.rates as unknown as Rates;
  let collegeHasRatesOverride = false;
  let collegeExpressOverride: Record<string, number> | null = null;
  if (collegeId) {
    const college = await db.college.findUnique({ where: { id: collegeId }, select: { rates: true, expressRates: true } });
    if (college?.rates) {
      rates = resolveCollegeRates(cfg.rates as unknown as Rates, college.rates as unknown as Rates);
      collegeHasRatesOverride = true;
    }
    if (college?.expressRates) collegeExpressOverride = college.expressRates as unknown as Record<string, number>;
  }

  return { ...cfg, rates, gstPct: Number(cfg.gstPct), gstEnabled, garmentTagsEnabled, collegeHasRatesOverride, collegeExpressOverride };
}

function bcast(o: { id: string; collegeId: string; studentId: string }, type = "order.updated") {
  publish(orderChannels(o), { type, payload: { orderId: o.id } });
}

/* ---------- Customer: place order (draft to bring to the counter) ---------- */
/* Cycle services (wash & fold / wash & iron) are sold by the CYCLE, not the
   garment — owner's Sep 2026 model. Rather than a second billing pipeline,
   a cycle order carries ONE synthetic line: { label: "… — cycle", rate: 200,
   qty: cycles }. Everything downstream — subtotal, the Sheet row, refunds —
   reads it like any other item, and `qty` doubles as the cycle count the way
   the owner asked pieces to. */
function cycleItems(service: string, label: string, cycles: number) {
  const n = Math.min(10, Math.max(1, Math.floor(cycles)));
  return [{ label: `${label} — cycle`, rate: CYCLE_RATES[service], qty: n }];
}

export async function placeOrder(input: { service: string; items: { label: string; qty: number }[]; cycles?: number; express: boolean; dropSlotAt?: string }) {
  const stu = await requireStudent();
  const cfg = await getConfig(stu.collegeId);
  const rate = cfg.rates[input.service];
  if (!rate) return { ok: false as const, error: "Unknown service" };
  if (!serviceOn(stu.college.features, input.service)) {
    return { ok: false as const, error: "This service is not available at your campus" };
  }

  const usesCycles = collegeUsesCycleBasedPricing(input.service, cfg.collegeHasRatesOverride);
  const cyclesCount = usesCycles ? Math.min(10, Math.max(1, Math.floor(input.cycles ?? 1))) : 1;
  const items = usesCycles
    ? cycleItems(input.service, rate.label, cyclesCount)
    : input.items
        .filter((i) => i.qty > 0)
        .map((i) => {
          const found = rate.items.find((r) => r[0] === i.label);
          if (!found) throw new Error("Unknown item " + i.label);
          return { label: found[0], rate: found[1], qty: Math.min(99, Math.floor(i.qty)) };
        });
  if (!items.length) return { ok: false as const, error: usesCycles ? "Pick at least one cycle" : "Add at least one piece" };

  // Drop-off slot is optional; when given, re-validate server-side (existence,
  // still in the future, and capacity) — never trust the client's pick.
  let dropSlotAt: Date | null = null, dropSlotEndAt: Date | null = null;
  if (input.dropSlotAt) {
    try {
      dropSlotEndAt = await assertSlotBookable(stu.collegeId, input.dropSlotAt);
      dropSlotAt = new Date(input.dropSlotAt);
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }

  const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
  /* Express defaults OFF. The old `!== false` meant a college whose map
     lacked the key would have the surcharge applied anyway — a money path
     turned on by an absent flag rather than a deliberate one. */
  const express = input.express && featureOn(stu.college.features, "express");
  // Flat same-day fee for every service (owner, Sep 2026) — no percentage anywhere.
  const surcharge = express ? collegeExpressFee(input.service, cfg.collegeExpressOverride) : 0;
  // Cycle-based orders never add GST; per-piece orders add GST if enabled.
  const gst = !usesCycles && cfg.gstEnabled ? Math.round((sub + surcharge) * (cfg.gstPct / 100)) : 0;
  const total = sub + surcharge + gst;

  const o = await db.order.create({
    data: {
      id: orderCode(), studentId: stu.id, collegeId: stu.collegeId, service: input.service,
      items, declaredPieces: items.reduce((s, i) => s + i.qty, 0),
      cyclesCount, noGst: usesCycles,
      express, surcharge, status: "draft",
      dropSlotAt, dropSlotEndAt,
      subtotal: sub, gst, gstPctSnapshot: cfg.gstEnabled ? cfg.gstPct : 0, total,
      timeline: { create: { status: "placed" } },
    },
  });
  bcast(o, "order.created");
  void notifyOwner(
    `New order #${o.id.slice(-4)}${express ? " (EXPRESS)" : ""}`,
    `${stu.name} pre-booked ${cfg.rates[input.service].label}: ${items.reduce((s, i) => s + i.qty, 0)} pieces, est. ₹${total}. Campus: ${stu.college.name}.`,
  );
  return { ok: true as const, id: o.id };
}

/* ---------- Staff: verify & accept (receive) ---------- */
export async function acceptOrder(orderId: string, input: { weightKg: number | null; useCycle: boolean; noGst?: boolean; waiveExcess?: boolean; cycles?: number; items?: { label: string; qty: number }[]; intakePhotos?: string[] }) {
  const st = await requireStaff(1);

  // Fetch the order first to get collegeId so we can get the right config
  const draftOrder = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { collegeId: true } });
  assertSameCollege(st, draftOrder.collegeId);
  const cfg = await getConfig(draftOrder.collegeId);

  let result;
  try {
    result = await db.$transaction(async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: { include: { subscription: { include: { planRef: true } } } } } });
    if (o.status !== "draft") throw new Error("Order already received");

    // staff may adjust quantities at the counter — for a per-piece service the
    // quantities are per-item; for cycle-based services the only adjustable quantity
    // IS the cycle count (a 9 kg bag becomes two)
    let items = o.items as unknown as { label: string; rate: number; qty: number }[];
    const usesCycles = collegeUsesCycleBasedPricing(o.service, cfg.collegeHasRatesOverride);
    const cyclesCount = usesCycles
      ? Math.min(10, Math.max(1, Math.floor(input.cycles ?? o.cyclesCount ?? 1)))
      : 1;
    if (usesCycles) {
      items = cycleItems(o.service, cfg.rates[o.service].label, cyclesCount);
    } else if (input.items) {
      const rate = cfg.rates[o.service];
      items = input.items.filter((i) => i.qty > 0).map((i) => {
        const found = rate.items.find((r) => r[0] === i.label);
        if (!found) throw new Error("Unknown item " + i.label);
        return { label: found[0], rate: found[1], qty: Math.floor(i.qty) };
      });
    }
    const declaredPieces = items.reduce((s, i) => s + i.qty, 0);
    if (!declaredPieces) throw new Error(usesCycles ? "Pick at least one cycle" : "Add at least one piece");

    let usedCycle = false, excessCharge = 0, urgentCharge = 0;
    /* Weight excess applies to EVERY cycle-service order — plan-paid or
       cash-paid, 5 kg x cycles is the allowance either way. Zero for
       per-piece services, whose weight is informational. */
    if (usesCycles) {
      excessCharge = excessWeightCharge(input.weightKg, undefined, { waived: !!input.waiveExcess, cycles: cyclesCount });
    }
    if (input.useCycle) {
      const sub = o.student.subscription;
      const blocked = subscriptionBlocker(sub);
      if (blocked || !sub) throw new Error(blocked || "No active subscription");
      type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
      const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
      if (buckets && buckets.length) {
        // multi-bucket plan: consume N cycles from the bucket matching THIS service
        const idx = buckets.findIndex((b) => b.service === o.service && b.used + cyclesCount <= b.cycles);
        if (idx < 0) throw new Error(`Not enough ${cfg.rates[o.service]?.label || o.service} cycles left on this plan (needs ${cyclesCount})`);
        buckets[idx] = { ...buckets[idx], used: buckets[idx].used + cyclesCount };
        await tx.subscription.update({ where: { id: sub.id }, data: { buckets, cyclesUsed: { increment: cyclesCount } } });
      } else {
        // legacy single-bucket subscription
        if (sub.cyclesUsed + cyclesCount > sub.cyclesTotal) throw new Error(`Not enough subscription cycles left (needs ${cyclesCount})`);
        await tx.subscription.update({ where: { id: sub.id }, data: { cyclesUsed: { increment: cyclesCount } } });
      }
      usedCycle = true;
      // One row per cycle burned, so cancelling restores exactly what was taken.
      await tx.cycleUse.createMany({ data: Array.from({ length: cyclesCount }, () => ({ subscriptionId: sub.id, orderId: o.id })) });
      // Urgent (same-day) on a plan-paid order: the cycle is already prepaid,
      // so only the flat same-day fee is charged, in cash, right now.
      if (o.express) urgentCharge = collegeExpressFee(o.service, cfg.collegeExpressOverride);
    }

    // recomputeOrder() — exact prototype math (+ optional no-GST billing).
    // GST is skipped when staff chose 'Bill without GST' OR GST billing is
    // switched off app-wide in Admin, or the service is cycle-based.
    const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
    // Flat fee for everyone, every service — plan-paid or cash-paid alike.
    const surcharge = o.express ? collegeExpressFee(o.service, cfg.collegeExpressOverride) : 0;
    // Cycle-based orders are FINAL (owner): Rs 200 means Rs 200, so GST never applies.
    const noGst = !usedCycle && (usesCycles || !!input.noGst || !cfg.gstEnabled);
    const { gst, total } = computeBill(sub, surcharge, cfg.gstPct, { usedCycle, excessCharge, noGst });

    // per-garment QR tags — one per piece. Parked feature, off by default.
    let ti = 0;
    const tags = cfg.garmentTagsEnabled
      ? items.flatMap((it) => Array.from({ length: it.qty }, () => ({ code: o.id.slice(-6) + "-" + String(++ti).padStart(2, "0"), label: it.label })))
      : [];

    const updated = await tx.order.update({
      where: { id: o.id },
      data: {
        items, declaredPieces, actualPieces: declaredPieces, weightKg: input.weightKg, cyclesCount,
        intakePhotos: input.intakePhotos?.length ? input.intakePhotos.slice(0, 6) : undefined,
        usedCycle, noGst, paid: usedCycle && total === 0 ? true : o.paid,
        paymentMethod: usedCycle && total === 0 ? "cycle" : o.paymentMethod,
        subtotal: sub, surcharge, gst, gstPctSnapshot: noGst ? 0 : cfg.gstPct, total,
        status: "received", receivedAt: new Date(),
        timeline: { create: { status: "received" } },
        tags: { create: tags },
      },
    });

    /* The live Sheet row for this order. Inside the transaction: if the accept
       rolls back, so does the row — the Sheet should never show an order the
       counter does not have. */
    await enqueueSheetEvent(tx, "order", [
      istStamp(),
      "#" + updated.id.slice(-6),
      await customerIdFor(tx, o.studentId),
      o.student.name,
      (await tx.college.findUnique({ where: { id: o.collegeId }, select: { name: true } }))?.name ?? "—",
      cfg.rates[updated.service]?.label ?? updated.service,
      declaredPieces,
      Number(updated.total),
      updated.paymentMethod ?? (usedCycle ? "cycle" : "unpaid"),
      usedCycle ? "yes" : "no",
      "received",
    ]);
    return updated;
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }

  await pushNotif(result.studentId, `Order received — ${result.actualPieces} pieces logged for ${cfg.rates[result.service].label}.`, "status");
  if (result.noGst) await audit("No-GST billing", `#${result.id.slice(-4)} ₹${Number(result.total)}`, st.id);
  /* A waiver only matters when there was something to waive. Recording who
     skipped the charge is what lets "why was 8 kg free?" be answered later. */
  if (input.waiveExcess && Number(input.weightKg) > CYCLE_KG_LIMIT) {
    await audit("Excess weight waived", `#${result.id.slice(-4)} ${input.weightKg} kg (limit ${CYCLE_KG_LIMIT})`, st.id);
  }
  if (result.usedCycle && Number(result.surcharge) > 0) await audit("Urgent cycle charge", `#${result.id.slice(-4)} ₹${Number(result.surcharge)} cash (cycle order)`, st.id);
  bcast(result);
  flushSoon();
  void st;
  return { ok: true as const, error: undefined };
}

/* ---------- Staff: WALK-IN order (no pre-booking) ----------
   A student hands over clothes at the counter without booking in the app.
   Creates + accepts in one step: counted, QR-tagged, priced (GST / no-GST /
   plan cycle) — so offline drop-offs are tracked exactly like app orders. */
export async function walkInOrder(
  studentId: string,
  input: { service: string; items: { label: string; qty: number }[]; cycles?: number; weightKg: number | null; useCycle: boolean; noGst?: boolean; waiveExcess?: boolean; express?: boolean; idemKey?: string | null },
) {
  const st = await requireStaff(1);

  /* An offline intake carries a key from the device that captured it. If that
     key is already on an order, this is a REPLAY — the previous attempt
     committed and something asked again. Return the existing order rather than
     booking the same bag in twice, and report it as success, because from the
     counter's point of view the order did go through. */
  if (input.idemKey) {
    const already = await db.order.findFirst({ where: { idemKey: input.idemKey }, select: { id: true } });
    if (already) return { ok: true as const, id: already.id, replayed: true };
  }

  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: { include: { planRef: true } }, college: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);

  // Fetch config with college context to get correct rates and pricing model
  const cfg = await getConfig(stu.collegeId);

  const rate = cfg.rates[input.service];
  if (!rate) return { ok: false as const, error: "Unknown service" };

  const usesCycles = collegeUsesCycleBasedPricing(input.service, cfg.collegeHasRatesOverride);
  const cyclesCount = usesCycles ? Math.min(10, Math.max(1, Math.floor(input.cycles ?? 1))) : 1;
  const items = usesCycles
    ? cycleItems(input.service, rate.label, cyclesCount)
    : input.items
        .filter((i) => i.qty > 0)
        .map((i) => {
          const found = rate.items.find((r) => r[0] === i.label);
          if (!found) throw new Error("Unknown item " + i.label);
          return { label: found[0], rate: found[1], qty: Math.min(99, Math.floor(i.qty)) };
        });
  if (!items.length) return { ok: false as const, error: usesCycles ? "Pick at least one cycle" : "Add at least one piece" };

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      // optional plan-cycle burn (same rules as acceptOrder)
      let usedCycle = false, excessCharge = 0, urgentCharge = 0;
      if (usesCycles) {
        // 5 kg x cycles allowance, plan-paid or cash-paid alike
        excessCharge = excessWeightCharge(input.weightKg, undefined, { waived: !!input.waiveExcess, cycles: cyclesCount });
      }
      if (input.useCycle) {
        const sub = stu.subscription;
        const blocked = subscriptionBlocker(sub);
        if (blocked || !sub) throw new Error(blocked || "No active subscription");
        type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
        const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
        if (buckets && buckets.length) {
          const idx = buckets.findIndex((b) => b.service === input.service && b.used + cyclesCount <= b.cycles);
          if (idx < 0) throw new Error(`Not enough ${rate.label} cycles left on this plan (needs ${cyclesCount})`);
          buckets[idx] = { ...buckets[idx], used: buckets[idx].used + cyclesCount };
          await tx.subscription.update({ where: { id: sub.id }, data: { buckets, cyclesUsed: { increment: cyclesCount } } });
        } else {
          if (sub.cyclesUsed + cyclesCount > sub.cyclesTotal) throw new Error(`Not enough subscription cycles left (needs ${cyclesCount})`);
          await tx.subscription.update({ where: { id: sub.id }, data: { cyclesUsed: { increment: cyclesCount } } });
        }
        usedCycle = true;
        // Urgent (same-day) on a plan-paid order: flat same-day fee, in cash.
        if (input.express) urgentCharge = collegeExpressFee(input.service, cfg.collegeExpressOverride);
      }

      const sub2 = items.reduce((s, i) => s + i.rate * i.qty, 0);
      const surcharge = input.express ? collegeExpressFee(input.service, cfg.collegeExpressOverride) : 0;
      // Cycle-based orders are FINAL (owner): Rs 200 means Rs 200, so GST never applies.
      const noGst = !usedCycle && (usesCycles || !!input.noGst || !cfg.gstEnabled);
      const { gst, total } = computeBill(sub2, surcharge, cfg.gstPct, { usedCycle, excessCharge, noGst });
      const declaredPieces = items.reduce((s, i) => s + i.qty, 0);
      const id = orderCode();
      let ti = 0;
      const tags = cfg.garmentTagsEnabled
        ? items.flatMap((it) => Array.from({ length: it.qty }, () => ({ code: id.slice(-6) + "-" + String(++ti).padStart(2, "0"), label: it.label })))
        : [];

      const o = await tx.order.create({
        data: {
          id, idemKey: input.idemKey || null,
          studentId: stu.id, collegeId: stu.collegeId, service: input.service,
          items, declaredPieces, actualPieces: declaredPieces, weightKg: input.weightKg, cyclesCount,
          express: !!input.express, surcharge, usedCycle, noGst,
          paid: usedCycle && total === 0, paymentMethod: usedCycle && total === 0 ? "cycle" : null,
          subtotal: sub2, gst, gstPctSnapshot: noGst ? 0 : cfg.gstPct, total,
          status: "received", receivedAt: new Date(),
          timeline: { create: [{ status: "placed" }, { status: "received" }] },
          tags: { create: tags },
        },
      });
      // One row per cycle actually consumed, not one row per order — a
      // multi-cycle walk-in was creating a single CycleUse row regardless of
      // cyclesCount while used/cyclesUsed advanced by the full count, so any
      // reconciliation counting CycleUse rows undercounted (acceptOrder's
      // equivalent path, line 189, already did this correctly).
      if (usedCycle) await tx.cycleUse.createMany({ data: Array.from({ length: cyclesCount }, () => ({ subscriptionId: stu.subscription!.id, orderId: o.id })) });
      await enqueueSheetEvent(tx, "order", [
        istStamp(),
        "#" + o.id.slice(-6),
        await customerIdFor(tx, stu.id),
        stu.name,
        (await tx.college.findUnique({ where: { id: stu.collegeId }, select: { name: true } }))?.name ?? "—",
        cfg.rates[o.service]?.label ?? o.service,
        declaredPieces,
        Number(o.total),
        o.paymentMethod ?? (usedCycle ? "cycle" : "unpaid"),
        usedCycle ? "yes" : "no",
        "received (walk-in)",
      ]);
      return o;
    });
  } catch (e) {
    /* Two replays racing each other: the lookup above found nothing for both,
       then the index rejected the loser. The order exists, so this is success. */
    if ((e as { code?: string }).code === "P2002" && input.idemKey) {
      const won = await db.order.findFirst({ where: { idemKey: input.idemKey }, select: { id: true } });
      if (won) return { ok: true as const, id: won.id, replayed: true };
    }
    return { ok: false as const, error: (e as Error).message };
  }

  await pushNotif(stu.id, `Walk-in order received — ${result.actualPieces} pieces logged for ${cfg.rates[result.service].label}.`, "status");
  await audit("Walk-in order", `#${result.id.slice(-4)} · ${stu.name} · ₹${Number(result.total)}${result.usedCycle ? " (cycle)" : ""}${result.noGst ? " (no GST)" : ""}`, st.id);
  if (result.noGst) await audit("No-GST billing", `#${result.id.slice(-4)} ₹${Number(result.total)}`, st.id);
  if (result.usedCycle && Number(result.surcharge) > 0) await audit("Urgent cycle charge", `#${result.id.slice(-4)} · ${stu.name} · ₹${Number(result.surcharge)} cash (cycle order)`, st.id);
  void notifyOwner(`Walk-in order #${result.id.slice(-4)}`, `${stu.name}: ${result.actualPieces} pieces of ${cfg.rates[result.service].label} — ₹${Number(result.total)}${result.usedCycle ? " (plan cycle)" : ""}. Logged by ${st.name}.`);
  bcast(result, "order.created");
  flushSoon();
  return { ok: true as const, id: result.id };
}

/* ---------- Staff: advance status ---------- */
/* `countedPieces` is the recount when folding is finished. Missing socks and
   stray items are the commonest laundry complaint, and the cheapest moment to
   catch one is BEFORE the student opens the bag — a proactive "we're a piece
   short" is an apology, the same fact discovered at the counter is a dispute. */
/**
 * Advance MANY orders one step in a single action.
 *
 * Twenty orders coming off the line means twenty taps through twenty screens;
 * this is the "mark the whole rail ready" button. Each order still goes
 * through advanceStatus itself — same permissions, same notifications, same
 * timeline rows — so batching changes the ergonomics, not the rules.
 *
 * Per-order outcomes are reported rather than all-or-nothing: one order that
 * cannot advance (already collected, say) must not hold the other nineteen.
 * The piece-recount step is deliberately unavailable here — counting is a
 * one-at-a-time act, and a batch that pretended to count would record numbers
 * nobody actually counted.
 */
export async function advanceStatusBatch(orderIds: string[]) {
  await requireStaff(1);
  const ids = [...new Set(orderIds)].slice(0, 50);
  if (!ids.length) return { ok: false as const, error: "Nothing selected" };
  const failed: { id: string; error: string }[] = [];
  let advanced = 0;
  for (const id of ids) {
    try {
      const r = await advanceStatus(id);
      if (r.ok) advanced++;
      else failed.push({ id, error: r.error ?? "failed" });
    } catch (e) {
      failed.push({ id, error: (e as Error).message });
    }
  }
  return { ok: true as const, advanced, failed };
}

export async function advanceStatus(orderId: string, input?: { countedPieces?: number | null }) {
  const st = await requireStaff(1);
  const cfg = await getConfig();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: true } });
  assertSameCollege(st, o.collegeId);
  const nextMap: Record<string, string> = { received: "processing", processing: "ready" };
  const next = nextMap[o.status];
  if (!next) return { ok: false as const, error: "Use the collect flow for ready orders" };

  // Reconcile the count on the way to ready, against what was logged at intake.
  let shortBy = 0;
  const counted = input?.countedPieces;
  const intakeCount = o.actualPieces ?? o.declaredPieces;
  if (next === "ready" && counted !== null && counted !== undefined) {
    const n = Math.max(0, Math.floor(Number(counted)));
    shortBy = Math.max(0, intakeCount - n);
    if (n !== intakeCount) {
      await db.order.update({ where: { id: o.id }, data: { actualPieces: n } });
      await audit(
        shortBy > 0 ? "Piece shortfall at ready" : "Piece count corrected at ready",
        `#${o.id.slice(-4)} · ${o.student.name} · intake ${intakeCount} → counted ${n}`,
        st.id,
      );
    }
  }

  await db.order.update({ where: { id: o.id }, data: { status: next, timeline: { create: { status: next } } } });

  if (next === "ready") {
    const code = rid(4);
    await db.otp.deleteMany({ where: { purpose: "pickup", refId: o.id } });
    await db.otp.create({ data: { phone: "", purpose: "pickup", code, refId: o.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    await pushNotif(o.studentId, `Your ${cfg.rates[o.service].label} order is ready for collection. Pickup code: ${code}.`, "ready");
    if (shortBy > 0) {
      // Tell them ourselves rather than letting them find out at the counter.
      await pushNotif(
        o.studentId,
        `Heads up on order #${o.id.slice(-4)}: we counted ${intakeCount - shortBy} pieces against ${intakeCount} logged at drop-off. We're looking into it — please check when you collect.`,
        "status",
      );
      void notifyOwner(
        `Piece shortfall — #${o.id.slice(-4)}`,
        `${o.student.name}: ${intakeCount} logged at intake, ${intakeCount - shortBy} counted at ready (short ${shortBy}). Flagged by ${st.name}.`,
      );
    }
  } else {
    await pushNotif(o.studentId, `Your order is now ${next}.`, "status");
  }
  bcast(o);
  return { ok: true as const, status: next };
}

/* ---------- Staff: collect (verify pickup code / order id) ---------- */
export async function collectOrder(orderId: string, code: string) {
  const st = await requireStaff(1);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assertSameCollege(st, o.collegeId);
  const otp = await db.otp.findFirst({ where: { purpose: "pickup", refId: o.id, usedAt: null } });
  const v = (code || "").replace(/[^0-9]/g, "");
  const ok = (otp && v === otp.code) || v === o.id.slice(-4) || v === o.id.replace(/\D/g, "");
  if (!ok) return { ok: false as const, error: "Code / Order ID does not match" };
  if (!o.paid && Number(o.total) > 0) return { ok: false as const, error: "Record payment before collection" };
  // Collection is the last step of the lifecycle (received → processing →
  // ready → collected) — every other transition enforces its starting state
  // explicitly, this one didn't, so an order could be marked collected
  // straight from "received"/"processing", skipping the piece-recount that
  // normally happens on the way to "ready" and trusting the customer's own
  // declared piece count as the final lifetimePieces figure.
  if (o.status !== "ready") return { ok: false as const, error: `Order is ${o.status}, not ready for collection` };

  try {
    await db.$transaction(async (tx) => {
      /* A plain `update` can't stop two concurrent taps (double-tap on a slow
         connection, or a retried offline-queue action): both read status !=
         "collected" before either writes, so a bare update would run twice —
         double-counting lifetimePieces and double-writing the Sheet row, with
         no unique index to collide on (unlike payCore's payment rows). Scoping
         the update itself to `status: "ready"` and checking the affected
         count makes the transition atomic: only the FIRST call's update
         actually matches a row, so only it proceeds. */
      const updated = await tx.order.updateMany({ where: { id: o.id, status: "ready" }, data: { status: "collected" } });
      if (updated.count === 0) throw new Error("This order was already collected");
      await tx.orderEvent.create({ data: { orderId: o.id, status: "collected" } });
      await tx.student.update({ where: { id: o.studentId }, data: { lifetimePieces: { increment: o.actualPieces || 0 } } });
      if (otp) await tx.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
      const stu = await tx.student.findUniqueOrThrow({ where: { id: o.studentId }, select: { name: true } });
      await enqueueSheetEvent(tx, "collection", [
        istStamp(),
        "#" + o.id.slice(-6),
        await customerIdFor(tx, o.studentId),
        stu.name,
        o.actualPieces || 0,
        st.name,
      ]);
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
  bcast(o);
  flushSoon();
  return { ok: true as const };
}

/* ---------- Payment (shared core: credit split + method + GST invoice) ---------- */
async function payCore(orderId: string, method: "upi" | "cash", creditApplied: number, opts: { staffInvoice?: boolean; gatewayRef?: string | null }) {
  /* The `o.paid` check below cannot stop a double tap on its own. Postgres runs
     READ COMMITTED, so two concurrent calls both read paid = false and both
     insert — and Payment rows are immutable, so the duplicate charge could
     never be removed. The unique index on (orderId, method) is what actually
     prevents it; this wrapper turns that collision into the same friendly
     message the sequential case gives, rather than a raw constraint error. */
  try {
    return await payInner(orderId, method, creditApplied, opts);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new Error("Already paid");
    throw e;
  }
}

async function payInner(orderId: string, method: "upi" | "cash", creditApplied: number, opts: { staffInvoice?: boolean; gatewayRef?: string | null }) {
  return db.$transaction(async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: true } });
    if (o.paid) throw new Error("Already paid");
    const total = Number(o.total);
    creditApplied = Math.max(0, Math.min(creditApplied, total));

    if (creditApplied > 0) {
      if (Number(o.student.credits) < creditApplied) throw new Error("Not enough credits");
      await tx.student.update({ where: { id: o.studentId }, data: { credits: { decrement: creditApplied } } });
      await tx.creditUse.create({ data: { studentId: o.studentId, orderId: o.id, amount: creditApplied } });
      await tx.payment.create({ data: { method: "credit", amount: creditApplied, orderId: o.id, collegeId: o.collegeId, studentId: o.studentId } });
    }
    const rest = total - creditApplied;
    if (rest > 0) {
      await tx.payment.create({ data: { method, amount: rest, orderId: o.id, collegeId: o.collegeId, studentId: o.studentId, gatewayRef: opts.gatewayRef || null } });
    }
    const paymentMethod = creditApplied >= total ? "credit" : creditApplied > 0 ? `${method}+credit` : method;
    const updated = await tx.order.update({ where: { id: o.id }, data: { paid: true, creditApplied, paymentMethod } });

    // GST is payment-method driven: UPI => invoice; cash only with staff override; credit-only never.
    // No-GST orders (staff choice at accept) are never invoiced, whatever the method.
    const invoice = shouldInvoiceOrder(updated, paymentMethod, opts.staffInvoice)
      ? await createInvoice(tx, updated, paymentMethod)
      : null;

    /* Live Sheet row, enqueued INSIDE this transaction so the log and the
       ledger can never disagree — a rolled-back payment takes its row with it. */
    await enqueueSheetEvent(tx, "payment", [
      istStamp(),
      "#" + o.id.slice(-6),
      await customerIdFor(tx, o.studentId),
      o.student.name,
      paymentMethod,
      total,
      Number(updated.gst) || 0,
      (invoice as { number?: string } | null)?.number ?? "—",
    ]);
    return updated;
  });
}

/* Customer pays own bill. */
export async function payOrder(orderId: string, method: "upi" | "cash", applyCredits: boolean, gatewayRef?: string) {
  const stu = await requireStudent();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.studentId !== stu.id) return { ok: false as const, error: "Not your order" };
  const creditApplied = applyCredits ? Math.min(Number(stu.credits), Number(o.total)) : 0;
  try {
    const updated = await payCore(orderId, method, creditApplied, { gatewayRef: gatewayRef || null });
    bcast(updated);
    flushSoon();
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/* Staff records payment at the counter ("GST bill for cash" override supported). */
export async function recordPay(orderId: string, method: "upi" | "cash", applyCredits: boolean, staffInvoice: boolean) {
  const st = await requireStaff(1);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: true } });
  assertSameCollege(st, o.collegeId);
  const creditApplied = applyCredits ? Math.min(Number(o.student.credits), Number(o.total)) : 0;
  if (staffInvoice && o.noGst) return { ok: false as const, error: "This order was billed without GST — no invoice can be issued" };
  try {
    const updated = await payCore(orderId, method, creditApplied, { staffInvoice });
    if (staffInvoice && method === "cash") await audit("GST bill for cash", `#${o.id.slice(-4)}`, st.id);
    bcast(updated);
    flushSoon();
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

export type ActionResult = { ok: boolean; error?: string; id?: string; status?: string };

/* ---------- Refund (negative payment + proportional GST credit note) ---------- */
/* `restoreCycle` is deliberately opt-in rather than automatic. A refund is not
   always a write-off: refunding just the urgent premium on a cycle order still
   means the wash happened, so handing the cycle back too would pay the student
   twice. Staff decide. */
export async function refundOrder(orderId: string, amount: number, via: "upi" | "cash" | "credit", reason: string, restoreCycle = false): Promise<ActionResult> {
  /* Was requireStaff(1) — ANY staff could give money back. Refunds are now a
     named tool: Manager+ by default, grantable or revocable per person. */
  const st = await requireStaffPerm("refunds");
  if (!amount || amount <= 0) return { ok: false, error: "Enter a valid amount" };
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true, student: { include: { subscription: true } } } });
  assertSameCollege(st, o.collegeId);
  // Nothing capped this against what was actually billed — a typo (₹5000
  // instead of ₹500) went through silently. Cap at the order total minus
  // whatever's already been refunded, same idea as payInner clamping
  // creditApplied to the order total.
  const refundableNow = (refunded: number) => Number(o.total) - refunded;
  if (amount > refundableNow(Number(o.refundAmount || 0))) {
    const r = refundableNow(Number(o.refundAmount || 0));
    return { ok: false, error: r > 0 ? `Only ₹${r} left to refund on this order` : "This order has already been fully refunded" };
  }

  try {
    await db.$transaction(async (tx) => {
      /* The pre-check above reads refundAmount OUTSIDE the transaction — on
         its own that's a TOCTOU gap identical to the one payCore's own
         comment warns about for double-payment: two near-simultaneous
         refunds (two staff, or a double-tap) could both read the same
         "before" refundAmount, both pass the cap check, and both commit,
         over-refunding the order. Lock the row, re-check against a FRESH
         read, and only then write — the same pattern already used for every
         other money-moving transition in this file. */
      const table = Prisma.raw(`${dbSchemaPrefix}"Order"`);
      await tx.$executeRaw`SELECT id FROM ${table} WHERE id = ${o.id} FOR UPDATE`;
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { refundAmount: true, total: true } });
      const stillRefundable = Number(fresh.total) - Number(fresh.refundAmount || 0);
      if (amount > stillRefundable) {
        throw new Error(stillRefundable > 0 ? `Only ₹${stillRefundable} left to refund on this order` : "This order has already been fully refunded");
      }
      await tx.payment.create({
        data: { method: "refund", refundVia: via, amount: -amount, orderId: o.id, collegeId: o.collegeId, studentId: o.studentId, note: "Refund" + (reason ? " — " + reason : "") },
      });
      if (via === "credit") await tx.student.update({ where: { id: o.studentId }, data: { credits: { increment: amount } } });
      if (o.invoice) await createCreditNote(tx, o.invoice, amount, reason, st.id, via);
      await tx.order.update({ where: { id: o.id }, data: { refunded: true, refundAmount: { increment: amount } } });
      if (restoreCycle) await restoreCycleFor(tx, o, o.student.subscription);
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  await pushNotif(o.studentId, via === "credit" ? `₹${amount} refunded to your store credits.${reason ? " " + reason : ""}` : `₹${amount} refunded via ${via.toUpperCase()}.${reason ? " " + reason : ""}`, "status");
  await audit("Refund", `#${o.id.slice(-4)} ₹${amount} via ${via}${restoreCycle ? " + cycle returned" : ""}${reason ? " — " + reason : ""}`, st.id);
  bcast(o);
  return { ok: true };
}

/* ---------- Free re-do ---------- */
export async function redoOrder(orderId: string): Promise<ActionResult> {
  const st = await requireStaff(1);
  const cfg = await getConfig();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  assertSameCollege(st, o.collegeId);
  // A re-do exists to make good on a real service failure — it makes no
  // sense against an order that was never actually placed for real (a draft)
  // or one the student already backed out of (cancelled). Unlike every other
  // transition this one had no starting-state check at all.
  if (o.status === "draft" || o.status === "cancelled") {
    return { ok: false, error: `Can't re-do a ${o.status} order` };
  }
  const n = await db.order.create({
    data: {
      id: orderCode(), studentId: o.studentId, collegeId: o.collegeId, service: o.service,
      items: o.items as object, declaredPieces: o.declaredPieces, actualPieces: o.actualPieces, weightKg: o.weightKg,
      express: false, surcharge: 0, status: "received", receivedAt: new Date(),
      subtotal: 0, gst: 0, gstPctSnapshot: cfg.gstPct, total: 0,
      paid: true, paymentMethod: "redo", redoOfId: o.id,
      timeline: { create: [{ status: "placed" }, { status: "received" }] },
    },
  });
  await pushNotif(o.studentId, `A free re-do was created for order #${o.id.slice(-4)} at no charge.`, "status");
  await audit("Free re-do", `from #${o.id.slice(-4)} → #${n.id.slice(-4)}`, st.id);
  /* Re-dos belong in the log too: they are real work at zero revenue, and the
     Sheet is where the cost of service failures should be visible. */
  const stu = await db.student.findUnique({ where: { id: o.studentId }, select: { name: true, collegeId: true } });
  await enqueueSheetEvent(db, "order", [
    istStamp(),
    "#" + n.id.slice(-6),
    await customerIdFor(db, o.studentId),
    stu?.name ?? "—",
    (await db.college.findUnique({ where: { id: o.collegeId }, select: { name: true } }))?.name ?? "—",
    cfg.rates[n.service]?.label ?? n.service,
    n.declaredPieces,
    0,
    "free re-do",
    "no",
    `re-do of #${o.id.slice(-6)}`,
  ]);
  bcast(n, "order.created");
  flushSoon();
  return { ok: true as const, id: n.id };
}

/* ---------- Cancel ---------- */
/* Can this subscription pay for a wash right now?

   Unused cycles are forfeited when the plan expires — they do not carry over to
   the next year and cannot be spent on anything else. That rule only means
   something if expiry is actually enforced at the moment a cycle is spent,
   which it previously was not: `active` stayed true past expiresAt, so an
   expired plan kept working. */
function subscriptionBlocker(sub: { active: boolean; expiresAt: Date | null } | null) {
  if (!sub || !sub.active) return "No active subscription";
  if (sub.expiresAt && sub.expiresAt.getTime() < Date.now()) {
    const on = sub.expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return `This plan expired on ${on} — unused cycles are forfeited. Renew to keep using cycles.`;
  }
  return null;
}

/* Give a consumed plan cycle back to the student.

   A cycle is prepaid value (~₹147 on a ₹5,000/34 plan), so losing one to an
   order that never got washed is real money out of their pocket. Restores the
   total, the per-service bucket it came from, and clears the log row so the
   balance and the history agree. Must run inside the caller's transaction — a
   half-restore is worse than none. */
async function restoreCycleFor(
  tx: Prisma.TransactionClient,
  ord: { id: string; service: string; usedCycle: boolean; cyclesCount?: number },
  sub: { id: string; cyclesUsed: number; buckets: unknown } | null,
) {
  if (!ord.usedCycle || !sub) return false;
  /* `sub` arrives as a snapshot fetched BEFORE this transaction started (both
     callers include it via `student: { include: { subscription: true } }`
     outside the tx). Writing `buckets` back as a whole-array overwrite from
     that stale snapshot would silently stomp any cycle consumed/restored by
     a DIFFERENT concurrent order in the gap between that read and this
     write — cyclesUsed (a relative `decrement`) stays correct, but the
     per-service bucket does not. Lock the row and re-read it fresh, same
     pattern as every other subscription writer in this codebase. */
  await tx.$executeRaw`SELECT id FROM ${Prisma.raw(`${dbSchemaPrefix}"Subscription"`)} WHERE id = ${sub.id} FOR UPDATE`;
  const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  /* Restore exactly what the order burned — a 2-cycle order gives 2 back.
     Clamped to what is actually recorded as used, so a legacy row can never
     drive a balance negative. */
  const n = Math.max(1, Math.floor(ord.cyclesCount ?? 1));
  type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
  const buckets = (fresh.buckets as unknown as Bucket[] | null) || null;
  const data: { cyclesUsed?: { decrement: number }; buckets?: Bucket[] } = {};
  if (fresh.cyclesUsed > 0) data.cyclesUsed = { decrement: Math.min(n, fresh.cyclesUsed) };
  if (buckets && buckets.length) {
    const idx = buckets.findIndex((b) => b.service === ord.service && b.used > 0);
    if (idx >= 0) {
      buckets[idx] = { ...buckets[idx], used: Math.max(0, buckets[idx].used - n) };
      data.buckets = buckets;
    }
  }
  if (Object.keys(data).length) await tx.subscription.update({ where: { id: fresh.id }, data });
  await tx.cycleUse.deleteMany({ where: { orderId: ord.id } });
  await tx.order.update({ where: { id: ord.id }, data: { usedCycle: false } });
  return true;
}

export async function cancelOrder(orderId: string): Promise<ActionResult> {
  const st = await requireStaff(1);
  const ord = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { student: { include: { subscription: true } } },
  });
  assertSameCollege(st, ord.collegeId);
  if (ord.status === "cancelled") return { ok: false as const, error: "This order is already cancelled" };
  if (ord.status === "collected") return { ok: false as const, error: "This order has already been collected" };

  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: ord.id }, data: { status: "cancelled", cancelledAt: new Date(), timeline: { create: { status: "cancelled" } } } });
    // Cancelling means the wash never happened, so the cycle always goes back.
    await restoreCycleFor(tx, ord, ord.student.subscription);
  });
  await db.otp.deleteMany({ where: { purpose: "pickup", refId: ord.id } });
  await pushNotif(ord.studentId, `Your order #${ord.id.slice(-4)} was cancelled.`, "status");
  await audit("Cancel order", `#${ord.id.slice(-4)}`, st.id);
  bcast(ord);
  return { ok: true as const };
}

/* ---------- Rating (customer, post-collection) ---------- */
export async function rateOrder(orderId: string, rating: number, comment: string) {
  const stu = await requireStudent();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.studentId !== stu.id) return { ok: false as const, error: "Not your order" };
  if (o.status !== "collected") return { ok: false as const, error: "Order not collected yet" };
  await db.order.update({ where: { id: o.id }, data: { rating: Math.max(1, Math.min(5, rating)), ratingComment: comment.trim() || null, ratedAt: new Date() } });
  bcast(o);
  return { ok: true as const };
}

/* ---------- Delete a draft (customer, own un-accepted order) ---------- */
export async function deleteDraft(orderId: string) {
  const stu = await requireStudent();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.studentId !== stu.id) return { ok: false as const, error: "Not your order" };
  if (o.status !== "draft") return { ok: false as const, error: "Only draft orders can be deleted" };
  await db.$transaction(async (tx) => {
    await tx.orderEvent.deleteMany({ where: { orderId: o.id } });
    await tx.garmentTag.deleteMany({ where: { orderId: o.id } });
    await tx.order.delete({ where: { id: o.id } });
  });
  bcast(o, "order.updated");
  return { ok: true as const };
}

/* ---------- Garment tag scan ---------- */
export async function scanTag(orderId: string, code: string) {
  const st = await requireStaff(1);
  const ord = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { collegeId: true } });
  assertSameCollege(st, ord.collegeId);
  const tag = await db.garmentTag.findUnique({ where: { code } });
  if (!tag || tag.orderId !== orderId) return { ok: false as const, error: "Tag not found on this order" };
  await db.garmentTag.update({ where: { id: tag.id }, data: { scanned: !tag.scanned } });
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  bcast(o);
  return { ok: true as const };
}
