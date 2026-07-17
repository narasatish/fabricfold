import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, STATUS_LABEL } from "@/lib/format";
import { Svg } from "@/components/icons";
import OrderNewClient from "./_components/OrderNewClient";
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

  // Validate service is enabled
  const feat = student.college.features as Record<string, boolean>;
  const FEAT_KEY: Record<string, string> = { washIron: "svc_wash", washFold: "svc_washfold", ironOnly: "svc_iron", dryClean: "svc_dryclean" };
  if (feat[FEAT_KEY[serviceParam] || ""] === false || !FEAT_KEY[serviceParam]) {
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
  ].filter((s) => feat[s.flag] !== false);

  const rate = rates[serviceParam] || rates.washIron;

  return (
    <div className="screen">
      <TopBar title="New order" sub="Declare what you'll bring" back="/c" />

      <div className="pad">
        <OrderNewClient
          enabledServices={enabledServices}
          currentService={serviceParam}
          rateItems={rate.items}
          gstPct={gstPct}
          expressEnabled={feat.express}
          reorderItems={reorderItems}
        />
      </div>
    </div>
  );
}
