import { requireStudent } from "@/lib/auth";
import { featureOn, serviceOn, type FeatureKey } from "@/lib/features";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, STATUS_LABEL } from "@/lib/format";
import { Svg } from "@/components/icons";
import OrderNewClient from "./_components/OrderNewClient";
import { listDropSlots } from "@/lib/actions/slots";
import { dayLabel } from "@/lib/slots";
import { redirect } from "next/navigation";

export default async function OrderNewPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const student = await requireStudent();
  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });

  if (!appConfig) redirect("/c");

  const rates = appConfig.rates as unknown as Record<string, { label: string; items: [string, number][] }>;
  const gstEnabled = (appConfig.settings as Record<string, unknown>)?.gstEnabled !== false;
  const gstPct = gstEnabled ? Number(appConfig.gstPct) : 0;
  const plan = appConfig.plan as unknown as { price: number; cycles: number; kgPerCycle: number };

  const sp = await searchParams;
  const serviceParam = sp.service || "washIron";
  const reorderParam = sp.reorder;

  // Validate service is enabled (serviceOn also rejects an unknown service)
  const feat = student.college.features;
  if (!serviceOn(feat, serviceParam)) {
    redirect("/c");
  }

  // If reorder, load items from that order
  let reorderItems: { label: string; qty: number }[] = [];
  if (reorderParam) {
    const originalOrder = await db.order.findUnique({ where: { id: reorderParam } });
    if (originalOrder?.studentId === student.id) {
      const items = originalOrder.items as unknown as Array<{ label: string; qty: number }>;
      reorderItems = items.map((i) => ({ label: i.label, qty: i.qty }));
    }
  }

  const enabledServices = [
    { key: "washIron", flag: "svc_wash", label: "Wash & Iron" },
    { key: "washFold", flag: "svc_washfold", label: "Wash & Fold" },
    { key: "ironOnly", flag: "svc_iron", label: "Iron Only" },
    { key: "dryClean", flag: "svc_dryclean", label: "Dry Clean" },
  ].filter((s) => featureOn(feat, s.flag as FeatureKey));

  const rate = rates[serviceParam] || rates.washIron;

  // Bookable drop-off windows for this student's campus (empty = feature unused here).
  const slots = await listDropSlots();
  const slotDayLabels: Record<string, string> = {};
  for (const s of slots) slotDayLabels[s.dateStr] ||= dayLabel(s.dateStr);

  return (
    <div className="screen">
      <TopBar title="New order" sub="Declare what you'll bring" back="/c" />

      <div className="pad">
        <OrderNewClient
          enabledServices={enabledServices}
          currentService={serviceParam}
          allRates={Object.fromEntries(enabledServices.map((sv) => [sv.key, rates[sv.key]?.items ?? []]))}
          gstPct={gstPct}
          expressEnabled={featureOn(feat, "express")}
          hasActiveSubscription={!!student.subscription?.active}
          reorderItems={reorderItems}
          slots={slots}
          slotDayLabels={slotDayLabels}
        />
      </div>
    </div>
  );
}
