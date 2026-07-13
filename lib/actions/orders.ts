"use server";
/* Order lifecycle — business rules ported EXACTLY from the prototype.
   Every mutation: validate role -> write (transaction) -> audit where the
   prototype does -> realtime broadcast -> notification. */
import { db } from "../db";
import { requireStudent, requireStaff } from "../auth";
import { EXPRESS_FEE, createInvoice, createCreditNote, shouldInvoiceOrder, computeBill } from "../money";
import { publish, orderChannels } from "../realtime";
import { pushNotif, audit } from "../notify";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };
const orderCode = () => "FF" + rid(6);

type Rates = Record<string, { label: string; items: [string, number][] }>;
async function getConfig() {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  // gstEnabled: owner can turn GST billing off entirely (not mandatory for
  // unregistered businesses). Default ON for backwards compatibility.
  const gstEnabled = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
  return { ...cfg, rates: cfg.rates as unknown as Rates, gstPct: Number(cfg.gstPct), gstEnabled };
}

function bcast(o: { id: string; collegeId: string; studentId: string }, type = "order.updated") {
  publish(orderChannels(o), { type, payload: { orderId: o.id } });
}

/* ---------- Customer: place order (draft to bring to the counter) ---------- */
export async function placeOrder(input: { service: string; items: { label: string; qty: number }[]; express: boolean }) {
  const stu = await requireStudent();
  const cfg = await getConfig();
  const rate = cfg.rates[input.service];
  if (!rate) return { ok: false as const, error: "Unknown service" };
  const feat = stu.college.features as Record<string, boolean>;
  const featKey = input.service === "washIron" ? "svc_wash" : input.service === "ironOnly" ? "svc_iron" : "svc_dryclean";
  if (feat[featKey] === false) return { ok: false as const, error: "This service is not available at your campus" };

  const items = input.items
    .filter((i) => i.qty > 0)
    .map((i) => {
      const found = rate.items.find((r) => r[0] === i.label);
      if (!found) throw new Error("Unknown item " + i.label);
      return { label: found[0], rate: found[1], qty: Math.min(99, Math.floor(i.qty)) };
    });
  if (!items.length) return { ok: false as const, error: "Add at least one piece" };

  const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
  const express = input.express && feat.express !== false;
  const surcharge = express ? EXPRESS_FEE : 0;
  const gst = cfg.gstEnabled ? Math.round((sub + surcharge) * (cfg.gstPct / 100)) : 0;
  const total = sub + surcharge + gst;

  const o = await db.order.create({
    data: {
      id: orderCode(), studentId: stu.id, collegeId: stu.collegeId, service: input.service,
      items, declaredPieces: items.reduce((s, i) => s + i.qty, 0),
      express, surcharge, status: "draft",
      subtotal: sub, gst, gstPctSnapshot: cfg.gstEnabled ? cfg.gstPct : 0, total,
      timeline: { create: { status: "placed" } },
    },
  });
  bcast(o, "order.created");
  return { ok: true as const, id: o.id };
}

/* ---------- Staff: verify & accept (receive) ---------- */
export async function acceptOrder(orderId: string, input: { weightKg: number | null; useCycle: boolean; noGst?: boolean; items?: { label: string; qty: number }[] }) {
  const st = await requireStaff(1);
  const cfg = await getConfig();

  let result;
  try {
    result = await db.$transaction(async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { student: { include: { subscription: true } } } });
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

    let usedCycle = false, excessCharge = 0;
    if (input.useCycle) {
      const sub = o.student.subscription;
      if (!sub || !sub.active || sub.cyclesUsed >= sub.cyclesTotal) throw new Error("No active subscription cycle available");
      usedCycle = true;
      await tx.subscription.update({ where: { id: sub.id }, data: { cyclesUsed: { increment: 1 } } });
      await tx.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o.id } });
      const plan = cfg.plan as { kgPerCycle: number };
      if (input.weightKg && input.weightKg > plan.kgPerCycle) {
        const excessKg = Math.ceil(input.weightKg - plan.kgPerCycle);
        const rate = cfg.rates.washIron.items[0][1];
        excessCharge = excessKg * rate * 3; // prototype: excess kg billed at 3x base piece rate per kg
      }
    }

    // recomputeOrder() — exact prototype math (+ optional no-GST billing).
    // GST is skipped when staff chose 'Bill without GST' OR GST billing is
    // switched off app-wide in Admin.
    const sub = items.reduce((s, i) => s + i.rate * i.qty, 0);
    const surcharge = o.express ? EXPRESS_FEE : 0;
    const noGst = !usedCycle && (!!input.noGst || !cfg.gstEnabled);
    const { gst, total } = computeBill(sub, surcharge, cfg.gstPct, { usedCycle, excessCharge, noGst });

    // per-garment QR tags — one per piece
    let ti = 0;
    const tags = items.flatMap((it) => Array.from({ length: it.qty }, () => ({ code: o.id.slice(-6) + "-" + String(++ti).padStart(2, "0"), label: it.label })));

    const updated = await tx.order.update({
      where: { id: o.id },
      data: {
        items, declaredPieces, actualPieces: declaredPieces, weightKg: input.weightKg,
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
  bcast(result);
  void st;
  return { ok: true as const, error: undefined };
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
  if (!o.paid && !o.usedCycle) return { ok: false as const, error: "Record payment before collection" };

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
export async function refundOrder(orderId: string, amount: number, via: "upi" | "cash" | "credit", reason: string): Promise<ActionResult> {
  const st = await requireStaff(1);
  if (!amount || amount <= 0) return { ok: false, error: "Enter a valid amount" };
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true } });

  await db.$transaction(async (tx) => {
    await tx.payment.create({
      data: { method: "refund", refundVia: via, amount: -amount, orderId: o.id, collegeId: o.collegeId, studentId: o.studentId, note: "Refund" + (reason ? " — " + reason : "") },
    });
    if (via === "credit") await tx.student.update({ where: { id: o.studentId }, data: { credits: { increment: amount } } });
    if (o.invoice) await createCreditNote(tx, o.invoice, amount, reason, st.id, via);
    await tx.order.update({ where: { id: o.id }, data: { refunded: true, refundAmount: { increment: amount } } });
  });

  await pushNotif(o.studentId, via === "credit" ? `₹${amount} refunded to your store credits.${reason ? " " + reason : ""}` : `₹${amount} refunded via ${via.toUpperCase()}.${reason ? " " + reason : ""}`, "status");
  await audit("Refund", `#${o.id.slice(-4)} ₹${amount} via ${via}${reason ? " — " + reason : ""}`, st.id);
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
export async function cancelOrder(orderId: string): Promise<ActionResult> {
  const st = await requireStaff(1);
  const ord = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  await db.order.update({ where: { id: ord.id }, data: { status: "cancelled", cancelledAt: new Date(), timeline: { create: { status: "cancelled" } } } });
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
