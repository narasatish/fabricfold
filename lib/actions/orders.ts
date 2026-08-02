"use server";
/* Order lifecycle — business rules ported EXACTLY from the prototype.
   Every mutation: validate role -> write (transaction) -> audit where the
   prototype does -> realtime broadcast -> notification. */
import { db } from "../db";
import type { Prisma } from "../generated/prisma/client";
import { requireStudent, requireStaff } from "../auth";
import { expressSurcharge, urgentCycleCharge, createInvoice, createCreditNote, shouldInvoiceOrder, computeBill } from "../money";
import { assertSlotBookable } from "../slot-capacity";
import { publish, orderChannels } from "../realtime";
import { pushNotif, audit } from "../notify";
import { notifyOwner } from "../mail";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };
const orderCode = () => "FF" + rid(6);

type Rates = Record<string, { label: string; items: [string, number][] }>;
async function getConfig() {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  // gstEnabled: owner can turn GST billing off entirely (not mandatory for
  // unregistered businesses). Default ON for backwards compatibility.
  const gstEnabled = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
  // Per-garment QR tagging: parked for now (not in use), default OFF. Flip
  // settings.garmentTagsEnabled = true in Admin to bring it back — the
  // scanning UI on the staff order screen only renders when tags exist, so
  // turning this back on is the only step needed.
  const garmentTagsEnabled = (cfg.settings as Record<string, unknown>)?.garmentTagsEnabled === true;
  return { ...cfg, rates: cfg.rates as unknown as Rates, gstPct: Number(cfg.gstPct), gstEnabled, garmentTagsEnabled };
}

function bcast(o: { id: string; collegeId: string; studentId: string }, type = "order.updated") {
  publish(orderChannels(o), { type, payload: { orderId: o.id } });
}

/* ---------- Customer: place order (draft to bring to the counter) ---------- */
export async function placeOrder(input: { service: string; items: { label: string; qty: number }[]; express: boolean; dropSlotAt?: string }) {
  const stu = await requireStudent();
  const cfg = await getConfig();
  const rate = cfg.rates[input.service];
  if (!rate) return { ok: false as const, error: "Unknown service" };
  const feat = stu.college.features as Record<string, boolean>;
  const FEAT_KEY: Record<string, string> = { washIron: "svc_wash", washFold: "svc_washfold", ironOnly: "svc_iron", dryClean: "svc_dryclean" };
  if (feat[FEAT_KEY[input.service] || ""] === false) return { ok: false as const, error: "This service is not available at your campus" };

  const items = input.items
    .filter((i) => i.qty > 0)
    .map((i) => {
      const found = rate.items.find((r) => r[0] === i.label);
      if (!found) throw new Error("Unknown item " + i.label);
      return { label: found[0], rate: found[1], qty: Math.min(99, Math.floor(i.qty)) };
    });
  if (!items.length) return { ok: false as const, error: "Add at least one piece" };

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
  const express = input.express && feat.express !== false;
  const surcharge = express ? expressSurcharge(sub) : 0;
  const gst = cfg.gstEnabled ? Math.round((sub + surcharge) * (cfg.gstPct / 100)) : 0;
  const total = sub + surcharge + gst;

  const o = await db.order.create({
    data: {
      id: orderCode(), studentId: stu.id, collegeId: stu.collegeId, service: input.service,
      items, declaredPieces: items.reduce((s, i) => s + i.qty, 0),
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
export async function acceptOrder(orderId: string, input: { weightKg: number | null; useCycle: boolean; noGst?: boolean; items?: { label: string; qty: number }[]; intakePhotos?: string[] }) {
  const st = await requireStaff(1);
  const cfg = await getConfig();

  let result;
  try {
    result = await db.$transaction(async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: { include: { subscription: { include: { planRef: true } } } } } });
    if (o.status !== "draft") throw new Error("Order already received");

    // staff may adjust quantities at the counter
    let items = o.items as unknown as { label: string; rate: number; qty: number }[];
    if (input.items) {
      const rate = cfg.rates[o.service];
      items = input.items.filter((i) => i.qty > 0).map((i) => {
        const found = rate.items.find((r) => r[0] === i.label);
        if (!found) throw new Error("Unknown item " + i.label);
        return { label: found[0], rate: found[1], qty: Math.floor(i.qty) };
      });
    }
    const declaredPieces = items.reduce((s, i) => s + i.qty, 0);
    if (!declaredPieces) throw new Error("Add at least one piece");

    let usedCycle = false, excessCharge = 0, urgentCharge = 0;
    if (input.useCycle) {
      const sub = o.student.subscription;
      const blocked = subscriptionBlocker(sub);
      if (blocked || !sub) throw new Error(blocked || "No active subscription");
      type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
      const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
      let kgLimit: number;
      if (buckets && buckets.length) {
        // multi-bucket plan: consume a cycle from the bucket matching THIS service
        const idx = buckets.findIndex((b) => b.service === o.service && b.used < b.cycles);
        if (idx < 0) throw new Error(`No ${cfg.rates[o.service]?.label || o.service} cycles left on this plan`);
        buckets[idx] = { ...buckets[idx], used: buckets[idx].used + 1 };
        kgLimit = Number(buckets[idx].kgPerCycle) || 7;
        await tx.subscription.update({ where: { id: sub.id }, data: { buckets, cyclesUsed: { increment: 1 } } });
      } else {
        // legacy single-bucket subscription
        if (sub.cyclesUsed >= sub.cyclesTotal) throw new Error("No active subscription cycle available");
        kgLimit = Number(sub.kgPerCycle) || (cfg.plan as { kgPerCycle: number }).kgPerCycle;
        await tx.subscription.update({ where: { id: sub.id }, data: { cyclesUsed: { increment: 1 } } });
      }
      usedCycle = true;
      await tx.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o.id } });
      if (input.weightKg && input.weightKg > kgLimit) {
        const excessKg = Math.ceil(input.weightKg - kgLimit);
        const rate = cfg.rates.washIron.items[0][1];
        excessCharge = excessKg * rate * 3; // prototype: excess kg billed at 3x base piece rate per kg
      }
      // Urgent (same-day) on a cycle order: the cycle is already prepaid, so
      // only the 40% urgent premium on its average value is charged, in cash,
      // right now — see urgentCycleCharge().
      if (o.express) {
        const planPrice = sub.planRef ? Number(sub.planRef.price) : Number((cfg.plan as { price: number }).price);
        urgentCharge = urgentCycleCharge(planPrice, sub.cyclesTotal);
      }
    }

    // recomputeOrder() — exact prototype math (+ optional no-GST billing).
    // GST is skipped when staff chose 'Bill without GST' OR GST billing is
    // switched off app-wide in Admin.
    const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
    const surcharge = usedCycle ? urgentCharge : (o.express ? expressSurcharge(sub) : 0);
    const noGst = !usedCycle && (!!input.noGst || !cfg.gstEnabled);
    const { gst, total } = computeBill(sub, surcharge, cfg.gstPct, { usedCycle, excessCharge, noGst });

    // per-garment QR tags — one per piece. Parked feature, off by default.
    let ti = 0;
    const tags = cfg.garmentTagsEnabled
      ? items.flatMap((it) => Array.from({ length: it.qty }, () => ({ code: o.id.slice(-6) + "-" + String(++ti).padStart(2, "0"), label: it.label })))
      : [];

    const updated = await tx.order.update({
      where: { id: o.id },
      data: {
        items, declaredPieces, actualPieces: declaredPieces, weightKg: input.weightKg,
        intakePhotos: input.intakePhotos?.length ? input.intakePhotos.slice(0, 6) : undefined,
        usedCycle, noGst, paid: usedCycle && total === 0 ? true : o.paid,
        paymentMethod: usedCycle && total === 0 ? "cycle" : o.paymentMethod,
        subtotal: sub, surcharge, gst, gstPctSnapshot: noGst ? 0 : cfg.gstPct, total,
        status: "received", receivedAt: new Date(),
        timeline: { create: { status: "received" } },
        tags: { create: tags },
      },
    });
    return updated;
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }

  await pushNotif(result.studentId, `Order received — ${result.actualPieces} pieces logged for ${cfg.rates[result.service].label}.`, "status");
  if (result.noGst) await audit("No-GST billing", `#${result.id.slice(-4)} ₹${Number(result.total)}`, st.id);
  if (result.usedCycle && Number(result.surcharge) > 0) await audit("Urgent cycle charge", `#${result.id.slice(-4)} ₹${Number(result.surcharge)} cash (cycle order)`, st.id);
  bcast(result);
  void st;
  return { ok: true as const, error: undefined };
}

/* ---------- Staff: WALK-IN order (no pre-booking) ----------
   A student hands over clothes at the counter without booking in the app.
   Creates + accepts in one step: counted, QR-tagged, priced (GST / no-GST /
   plan cycle) — so offline drop-offs are tracked exactly like app orders. */
export async function walkInOrder(
  studentId: string,
  input: { service: string; items: { label: string; qty: number }[]; weightKg: number | null; useCycle: boolean; noGst?: boolean; express?: boolean },
) {
  const st = await requireStaff(1);
  const cfg = await getConfig();
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: { include: { planRef: true } }, college: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  const rate = cfg.rates[input.service];
  if (!rate) return { ok: false as const, error: "Unknown service" };

  const items = input.items
    .filter((i) => i.qty > 0)
    .map((i) => {
      const found = rate.items.find((r) => r[0] === i.label);
      if (!found) throw new Error("Unknown item " + i.label);
      return { label: found[0], rate: found[1], qty: Math.min(99, Math.floor(i.qty)) };
    });
  if (!items.length) return { ok: false as const, error: "Add at least one piece" };

  let result;
  try {
    result = await db.$transaction(async (tx) => {
      // optional plan-cycle burn (same rules as acceptOrder)
      let usedCycle = false, excessCharge = 0, urgentCharge = 0;
      if (input.useCycle) {
        const sub = stu.subscription;
        const blocked = subscriptionBlocker(sub);
        if (blocked || !sub) throw new Error(blocked || "No active subscription");
        type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
        const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
        let kgLimit: number;
        if (buckets && buckets.length) {
          const idx = buckets.findIndex((b) => b.service === input.service && b.used < b.cycles);
          if (idx < 0) throw new Error(`No ${rate.label} cycles left on this plan`);
          buckets[idx] = { ...buckets[idx], used: buckets[idx].used + 1 };
          kgLimit = Number(buckets[idx].kgPerCycle) || 7;
          await tx.subscription.update({ where: { id: sub.id }, data: { buckets, cyclesUsed: { increment: 1 } } });
        } else {
          if (sub.cyclesUsed >= sub.cyclesTotal) throw new Error("No subscription cycles left");
          kgLimit = Number(sub.kgPerCycle) || 7;
          await tx.subscription.update({ where: { id: sub.id }, data: { cyclesUsed: { increment: 1 } } });
        }
        usedCycle = true;
        if (input.weightKg && input.weightKg > kgLimit) {
          const excessKg = Math.ceil(input.weightKg - kgLimit);
          excessCharge = excessKg * cfg.rates.washIron.items[0][1] * 3;
        }
        // Urgent (same-day) on a cycle order: the cycle is already prepaid, so
        // only the 40% urgent premium on its average value is charged, in cash.
        if (input.express) {
          const planPrice = sub.planRef ? Number(sub.planRef.price) : Number((cfg.plan as { price: number }).price);
          urgentCharge = urgentCycleCharge(planPrice, sub.cyclesTotal);
        }
      }

      const sub2 = items.reduce((s, i) => s + i.rate * i.qty, 0);
      const surcharge = usedCycle ? urgentCharge : (input.express ? expressSurcharge(sub2) : 0);
      const noGst = !usedCycle && (!!input.noGst || !cfg.gstEnabled);
      const { gst, total } = computeBill(sub2, surcharge, cfg.gstPct, { usedCycle, excessCharge, noGst });
      const declaredPieces = items.reduce((s, i) => s + i.qty, 0);
      const id = orderCode();
      let ti = 0;
      const tags = cfg.garmentTagsEnabled
        ? items.flatMap((it) => Array.from({ length: it.qty }, () => ({ code: id.slice(-6) + "-" + String(++ti).padStart(2, "0"), label: it.label })))
        : [];

      const o = await tx.order.create({
        data: {
          id, studentId: stu.id, collegeId: stu.collegeId, service: input.service,
          items, declaredPieces, actualPieces: declaredPieces, weightKg: input.weightKg,
          express: !!input.express, surcharge, usedCycle, noGst,
          paid: usedCycle && total === 0, paymentMethod: usedCycle && total === 0 ? "cycle" : null,
          subtotal: sub2, gst, gstPctSnapshot: noGst ? 0 : cfg.gstPct, total,
          status: "received", receivedAt: new Date(),
          timeline: { create: [{ status: "placed" }, { status: "received" }] },
          tags: { create: tags },
        },
      });
      if (usedCycle) await tx.cycleUse.create({ data: { subscriptionId: stu.subscription!.id, orderId: o.id } });
      return o;
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }

  await pushNotif(stu.id, `Walk-in order received — ${result.actualPieces} pieces logged for ${cfg.rates[result.service].label}.`, "status");
  await audit("Walk-in order", `#${result.id.slice(-4)} · ${stu.name} · ₹${Number(result.total)}${result.usedCycle ? " (cycle)" : ""}${result.noGst ? " (no GST)" : ""}`, st.id);
  if (result.noGst) await audit("No-GST billing", `#${result.id.slice(-4)} ₹${Number(result.total)}`, st.id);
  if (result.usedCycle && Number(result.surcharge) > 0) await audit("Urgent cycle charge", `#${result.id.slice(-4)} · ${stu.name} · ₹${Number(result.surcharge)} cash (cycle order)`, st.id);
  void notifyOwner(`Walk-in order #${result.id.slice(-4)}`, `${stu.name}: ${result.actualPieces} pieces of ${cfg.rates[result.service].label} — ₹${Number(result.total)}${result.usedCycle ? " (plan cycle)" : ""}. Logged by ${st.name}.`);
  bcast(result, "order.created");
  return { ok: true as const, id: result.id };
}

/* ---------- Staff: advance status ---------- */
export async function advanceStatus(orderId: string) {
  await requireStaff(1);
  const cfg = await getConfig();
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const nextMap: Record<string, string> = { received: "processing", processing: "ready" };
  const next = nextMap[o.status];
  if (!next) return { ok: false as const, error: "Use the collect flow for ready orders" };

  await db.order.update({ where: { id: o.id }, data: { status: next, timeline: { create: { status: next } } } });

  if (next === "ready") {
    const code = rid(4);
    await db.otp.deleteMany({ where: { purpose: "pickup", refId: o.id } });
    await db.otp.create({ data: { phone: "", purpose: "pickup", code, refId: o.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
    await pushNotif(o.studentId, `Your ${cfg.rates[o.service].label} order is ready for collection. Pickup code: ${code}.`, "ready");
  } else {
    await pushNotif(o.studentId, `Your order is now ${next}.`, "status");
  }
  bcast(o);
  return { ok: true as const, status: next };
}

/* ---------- Staff: collect (verify pickup code / order id) ---------- */
export async function collectOrder(orderId: string, code: string) {
  await requireStaff(1);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const otp = await db.otp.findFirst({ where: { purpose: "pickup", refId: o.id, usedAt: null } });
  const v = (code || "").replace(/[^0-9]/g, "");
  const ok = (otp && v === otp.code) || v === o.id.slice(-4) || v === o.id.replace(/\D/g, "");
  if (!ok) return { ok: false as const, error: "Code / Order ID does not match" };
  if (!o.paid && Number(o.total) > 0) return { ok: false as const, error: "Record payment before collection" };

  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: o.id }, data: { status: "collected", timeline: { create: { status: "collected" } } } });
    await tx.student.update({ where: { id: o.studentId }, data: { lifetimePieces: { increment: o.actualPieces || 0 } } });
    if (otp) await tx.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  });
  bcast(o);
  return { ok: true as const };
}

/* ---------- Payment (shared core: credit split + method + GST invoice) ---------- */
async function payCore(orderId: string, method: "upi" | "cash", creditApplied: number, opts: { staffInvoice?: boolean; gatewayRef?: string | null }) {
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
    if (shouldInvoiceOrder(updated, paymentMethod, opts.staffInvoice)) await createInvoice(tx, updated, paymentMethod);
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
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/* Staff records payment at the counter ("GST bill for cash" override supported). */
export async function recordPay(orderId: string, method: "upi" | "cash", applyCredits: boolean, staffInvoice: boolean) {
  const st = await requireStaff(1);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: true } });
  const creditApplied = applyCredits ? Math.min(Number(o.student.credits), Number(o.total)) : 0;
  if (staffInvoice && o.noGst) return { ok: false as const, error: "This order was billed without GST — no invoice can be issued" };
  try {
    const updated = await payCore(orderId, method, creditApplied, { staffInvoice });
    if (staffInvoice && method === "cash") await audit("GST bill for cash", `#${o.id.slice(-4)}`, st.id);
    bcast(updated);
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
  const st = await requireStaff(1);
  if (!amount || amount <= 0) return { ok: false, error: "Enter a valid amount" };
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true, student: { include: { subscription: true } } } });

  await db.$transaction(async (tx) => {
    await tx.payment.create({
      data: { method: "refund", refundVia: via, amount: -amount, orderId: o.id, collegeId: o.collegeId, studentId: o.studentId, note: "Refund" + (reason ? " — " + reason : "") },
    });
    if (via === "credit") await tx.student.update({ where: { id: o.studentId }, data: { credits: { increment: amount } } });
    if (o.invoice) await createCreditNote(tx, o.invoice, amount, reason, st.id, via);
    await tx.order.update({ where: { id: o.id }, data: { refunded: true, refundAmount: { increment: amount } } });
    if (restoreCycle) await restoreCycleFor(tx, o, o.student.subscription);
  });

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
  bcast(n, "order.created");
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
  ord: { id: string; service: string; usedCycle: boolean },
  sub: { id: string; cyclesUsed: number; buckets: unknown } | null,
) {
  if (!ord.usedCycle || !sub) return false;
  type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
  const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
  const data: { cyclesUsed?: { decrement: number }; buckets?: Bucket[] } = {};
  if (sub.cyclesUsed > 0) data.cyclesUsed = { decrement: 1 };
  if (buckets && buckets.length) {
    const idx = buckets.findIndex((b) => b.service === ord.service && b.used > 0);
    if (idx >= 0) {
      buckets[idx] = { ...buckets[idx], used: buckets[idx].used - 1 };
      data.buckets = buckets;
    }
  }
  if (Object.keys(data).length) await tx.subscription.update({ where: { id: sub.id }, data });
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
  await requireStaff(1);
  const tag = await db.garmentTag.findUnique({ where: { code } });
  if (!tag || tag.orderId !== orderId) return { ok: false as const, error: "Tag not found on this order" };
  await db.garmentTag.update({ where: { id: tag.id }, data: { scanned: !tag.scanned } });
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  bcast(o);
  return { ok: true as const };
}
