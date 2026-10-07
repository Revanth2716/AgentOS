/** Lightweight SVG chart primitives — no chart library dependency. */

export function Sparkline({
  points,
  height = 40,
  stroke = 'var(--accent)',
  fill = true,
}: {
  points: number[];
  height?: number;
  stroke?: string;
  fill?: boolean;
}) {
  if (points.length === 0) return <svg width={height * 3} height={height} />;
  const w = Math.max(60, points.length * 14);
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const coords = points.map((p, i) => {
    const x = (i / Math.max(1, points.length - 1)) * w;
    const y = height - ((p - min) / span) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={height} className="overflow-visible">
      {fill ? (
        <polygon points={`0,${height} ${coords.join(' ')} ${w},${height}`} fill={stroke} opacity={0.12} />
      ) : null}
      <polyline points={coords.join(' ')} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

export function BarSeries({
  data,
  height = 120,
  color = 'var(--accent)',
  secondaryColor = 'var(--danger)',
  labels,
}: {
  data: { label: string; value: number; secondary?: number }[];
  height?: number;
  color?: string;
  secondaryColor?: string;
  labels?: boolean;
}) {
  if (data.length === 0) return <div className="text-muted text-[12px]">No data yet</div>;
  const max = Math.max(...data.map((d) => Math.max(d.value, d.secondary ?? 0)), 1);
  const barW = 100 / data.length;
  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} width="100%" height={height} preserveAspectRatio="none">
        {data.map((d, i) => {
          const h = (d.value / max) * (height - 6);
          const sh = d.secondary ? (d.secondary / max) * (height - 6) : 0;
          return (
            <g key={d.label}>
              <rect x={i * barW + barW * 0.18} y={height - h} width={barW * 0.64} height={h} fill={color} rx={0.6} />
              {d.secondary ? (
                <rect
                  x={i * barW + barW * 0.18}
                  y={height - h - sh}
                  width={barW * 0.64}
                  height={sh}
                  fill={secondaryColor}
                  rx={0.6}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {labels ? (
        <div className="flex text-[10px] text-muted mt-1">
          {data.map((d) => (
            <div key={d.label} style={{ width: `${100 / data.length}%` }} className="text-center truncate px-0.5">
              {d.label}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProgressBar({ value, max = 1, color = 'var(--ok)' }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="h-1.5 bg-panel2 rounded-full overflow-hidden w-full">
      <div style={{ width: `${pct}%`, background: color }} className="h-full rounded-full" />
    </div>
  );
}

export function Donut({ value, size = 64, color = 'var(--ok)' }: { value: number; size?: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value));
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fontSize={13} fill="var(--ink)" fontWeight={600}>
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}
