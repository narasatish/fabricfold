export default function StudentsLoading() {
  return (
    <div className="screen">
      <div className="pad">
        <div style={{ height: 40, background: "var(--muted)", borderRadius: 4, marginBottom: 16 }} />
        <div className="list">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="list-item">
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--muted)", marginRight: 12, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ height: 16, background: "var(--muted)", borderRadius: 2, marginBottom: 6, width: "40%" }} />
                <div style={{ height: 12, background: "var(--muted-soft)", borderRadius: 2, width: "30%" }} />
              </div>
              <div style={{ height: 20, width: 60, background: "var(--muted)", borderRadius: 2 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
