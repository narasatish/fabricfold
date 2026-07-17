import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt, timeAgo, dateStr, loyaltyBadge, STATUS_LABEL } from "@/lib/format";
import Link from "next/link";
import { Qr } from "@/components/qr";
import HomeClient from "./_components/HomeClient";

export default async function CustomerHome() {
  const student = await requireStudent();
  const college = student.college;
  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });

  // Parse rates from config
  const rates = appConfig?.rates as unknown as Record<string, { label: string; items: [string, number][] }>;

  // Get active orders (not draft, not collected)
  const activeOrders = await db.order.findMany({
    where: {
      studentId: student.id,
      status: { in: ["received", "processing", "ready"] },
    },
    orderBy: { createdAt: "desc" },
  });

  // Get draft orders
  const drafts = await db.order.findMany({
    where: { studentId: student.id, status: "draft" },
    orderBy: { createdAt: "desc" },
  });

  // Get unread notifications count
  const unreadCount = await db.notification.count({
    where: { studentId: student.id, read: false },
  });

  // Check subscription expiry
  const sub = student.subscription;
  const subExpiryWarning = sub?.active && sub.expiresAt && sub.expiresAt.getTime() - Date.now() < 30 * 86400000;

  // Build enabled services
  const services: Array<{ key: string; flag: string; label: string; icon: string }> = [
    { key: "washIron", flag: "svc_wash", label: "Wash & Iron", icon: "layers" },
    { key: "washFold", flag: "svc_washfold", label: "Wash & Fold", icon: "gift" },
    { key: "ironOnly", flag: "svc_iron", label: "Iron Only", icon: "shirt" },
    { key: "dryClean", flag: "svc_dryclean", label: "Dry Clean", icon: "bag" },
  ];

  const enabledServices = services.filter((s) => (college.features as Record<string, boolean>)?.[s.flag]);

  const loyaltyTier = loyaltyBadge(student.lifetimePieces);

  return (
    <div className="screen">
      <TopBar
        title="FabricFold"
        sub={college ? college.name : undefined}
        right={
          <Link href="/c/notifications" className="action" style={{ position: "relative" }}>
            <Svg name="bell" size={22} />
            {unreadCount > 0 && <span className="notif-dot" />}
          </Link>
        }
      />

      <div className="pad">
        {/* ID Card */}
        <div
          className="card pad"
          style={{
            background: "linear-gradient(135deg,var(--teal),var(--teal-dark))",
            color: "#fff",
            border: "none",
            boxShadow: "0 8px 24px rgba(15,138,102,.3)",
          }}
        >
          <div className="between">
            <div>
              <div style={{ fontSize: "12px", opacity: 0.85, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
                FabricFold ID
              </div>
              <div className="big-num mono mt4" style={{ letterSpacing: ".06em" }}>
                {student.id}
              </div>
            </div>
            <div
              style={{
                width: "52px",
                height: "52px",
                borderRadius: "14px",
                background: "rgba(255,255,255,.15)",
                display: "grid",
                placeItems: "center",
                overflow: "hidden", // belt-and-braces: never let the QR escape the chip
                flex: "none",
              }}
            >
              {/* must fit the 52px chip — a larger size overflows the whole ID card */}
              <Qr text={student.id} size={40} dark="#fff" light="transparent" />
            </div>
          </div>
          <div className="between" style={{ marginTop: "12px" }}>
            <span style={{ fontSize: "12.5px", opacity: 0.85 }}>Show this ID at the counter</span>
            <span style={{ fontSize: "12px", background: "rgba(255,255,255,.2)", padding: "4px 10px", borderRadius: "999px", fontWeight: 600 }}>
              {loyaltyTier.name} · {student.lifetimePieces} pcs
            </span>
          </div>
        </div>

        {/* Subscription expiry warning */}
        {subExpiryWarning && (
          <div className="card pad mt12" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4" }}>
            <div className="row gap8">
              <span style={{ color: "var(--amber)" }}>
                <Svg name="alert" size={18} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="h-sm" style={{ color: "var(--amber)" }}>
                  Plan renews soon
                </div>
                <div style={{ color: "var(--amber)", fontSize: "12px" }}>
                  Expires {sub?.expiresAt ? dateStr(sub.expiresAt) : "—"} · renew to stay covered
                </div>
              </div>
              <Link href="/c/wallet" className="btn xs">
                Renew
              </Link>
            </div>
          </div>
        )}

        {/* Subscription mini card */}
        {sub?.active && (
          <HomeClient />
        )}

        {/* Credit balance card */}
        {Number(student.credits) > 0 && (
          <Link href="/c/wallet" className="card between mt12" style={{ padding: "14px 16px", width: "100%", textDecoration: "none" }}>
            <span className="row gap8">
              <span style={{ color: "var(--teal)" }}>
                <Svg name="gift" size={20} />
              </span>
              <span>
                <span className="h-sm">Credit balance</span>
              </span>
            </span>
            <span className="h-md" style={{ color: "var(--teal-dark)" }}>
              {fmt(Number(student.credits))}
            </span>
          </Link>
        )}

        {/* Service tiles */}
        <div className="sec-title mt20">Start an order</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
          {enabledServices.map((svc) => (
            <Link
              key={svc.key}
              href={`/c/order/new?service=${svc.key}`}
              className="card"
              style={{ padding: "16px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: "9px", textDecoration: "none" }}
            >
              <div className="icon-tile" style={{ width: "40px", height: "40px" }}>
                <Svg name={svc.icon} size={20} />
              </div>
              <div style={{ fontSize: "12px", fontWeight: 600, textAlign: "center", lineHeight: 1.25 }}>
                {svc.label}
              </div>
            </Link>
          ))}
        </div>
        <Link href="/c/order/new" className="btn mt12">
          <Svg name="plus" size={20} /> Pre-book an order
        </Link>

        {/* Draft orders */}
        {drafts.length > 0 && (
          <>
            <div className="sec-title mt20">Draft — bring to counter</div>
            {drafts.map((o) => (
              <OrderRow key={o.id} order={o} rates={rates} />
            ))}
          </>
        )}

        {/* Active orders */}
        <div className="sec-title mt20">Active orders</div>
        {activeOrders.length > 0 ? (
          activeOrders.map((o) => (
            <OrderRow key={o.id} order={o} rates={rates} />
          ))
        ) : (
          <div className="card pad center muted" style={{ padding: "28px" }}>
            No active orders right now
          </div>
        )}
      </div>
    </div>
  );
}

function OrderRow({ order, rates }: { order: any; rates: Record<string, any> }) {
  const items = order.items as unknown as Array<{ label: string; qty: number }>;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const rateLabel = rates?.[order.service]?.label || order.service;

  return (
    <Link
      href={`/c/orders/${order.id}`}
      className="card mt10"
      style={{ padding: "14px 16px", width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: "13px", textDecoration: "none" }}
    >
      <div
        className="icon-tile"
        style={{
          background:
            order.status === "ready"
              ? "var(--teal-soft)"
              : order.status === "draft"
                ? "var(--line)"
                : "var(--teal-tint)",
        }}
      >
        <Svg name={order.status === "ready" ? "ready" : order.status === "draft" ? "edit" : "bag"} size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="between">
          <span className="h-sm">{rateLabel}</span>
          <span className="mono muted" style={{ fontSize: "12px" }}>
            #{order.id.slice(-4)}
          </span>
        </div>
        <div className="row gap8 mt4" style={{ flexWrap: "wrap" }}>
          <span className={`pill st-${order.status}`}>
            {STATUS_LABEL[order.status] || order.status}
          </span>
          <span className="muted" style={{ fontSize: "12.5px" }}>
            {totalQty} pcs · {fmt(order.total)}
          </span>
          <span className="muted" style={{ fontSize: "12.5px" }}>
            {dateStr(order.createdAt)}
          </span>
          {order.express && (
            <span className="pill amber">
              <Svg name="bolt" size={11} /> Express
            </span>
          )}
        </div>
      </div>
      <span style={{ color: "var(--faint)" }}>
        <Svg name="chevR" size={18} />
      </span>
    </Link>
  );
}
