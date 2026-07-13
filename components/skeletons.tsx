/* Instant loading shells — shown the moment you tap, before data arrives.
   This is what makes navigation feel native instead of "stuck". */

export function SkelBar({ w = "100%", h = 14, mt = 0 }: { w?: string | number; h?: number; mt?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, marginTop: mt }} />;
}

export function SkelCard({ lines = 3, h }: { lines?: number; h?: number }) {
  return (
    <div className="card pad mt10" style={h ? { height: h } : undefined}>
      <SkelBar w="45%" h={16} />
      {Array.from({ length: lines - 1 }, (_, i) => (
        <SkelBar key={i} w={`${85 - i * 18}%`} mt={10} />
      ))}
    </div>
  );
}

export function ScreenSkeleton({ title, cards = 3 }: { title?: string; cards?: number }) {
  return (
    <div className="screen">
      <div className="topbar">
        <div>
          {title ? <h1>{title}</h1> : <SkelBar w={120} h={18} />}
        </div>
      </div>
      <div className="pad">
        {Array.from({ length: cards }, (_, i) => (
          <SkelCard key={i} lines={i === 0 ? 4 : 3} />
        ))}
      </div>
    </div>
  );
}
