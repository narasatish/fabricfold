export default function ReportsLoading() {
  return (
    <div className="screen">
      <div className="pad">
        <div style={{ height: 40, background: "var(--muted)", borderRadius: 4, marginBottom: 16 }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 20 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="card pad" style={{ minHeight: 80 }}>
              <div style={{ height: 16, background: "var(--muted)", borderRadius: 2, marginBottom: 8 }} />
              <div style={{ height: 20, background: "var(--muted)", borderRadius: 2, width: "60%" }} />
            </div>
          ))}
        </div>
        <div className="card pad" style={{ minHeight: 200 }}>
          <div style={{ height: 24, background: "var(--muted)", borderRadius: 2, marginBottom: 16 }} />
          <div style={{ height: 100, background: "var(--muted-soft)", borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}
