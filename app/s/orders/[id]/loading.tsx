export default function OrderLoading() {
  return (
    <div className="screen">
      <div className="pad">
        <div style={{ height: 32, background: "var(--muted)", borderRadius: 4, marginBottom: 20 }} />
        <div className="card pad" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ height: 12, background: "var(--muted-soft)", borderRadius: 2, marginBottom: 6, width: "50%" }} />
              <div style={{ height: 20, background: "var(--muted)", borderRadius: 2, width: "70%" }} />
            </div>
            <div>
              <div style={{ height: 12, background: "var(--muted-soft)", borderRadius: 2, marginBottom: 6, width: "50%" }} />
              <div style={{ height: 20, background: "var(--muted)", borderRadius: 2, width: "70%" }} />
            </div>
          </div>
          <div style={{ height: 100, background: "var(--muted-soft)", borderRadius: 2 }} />
        </div>
        <div className="card pad" style={{ minHeight: 150 }}>
          <div style={{ height: 24, background: "var(--muted)", borderRadius: 2, marginBottom: 12 }} />
          <div style={{ height: 80, background: "var(--muted-soft)", borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}
