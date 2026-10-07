import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-panel border border-border rounded-xl ${className}`}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-muted mt-1 text-[13px]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  completed: 'bg-ok-soft text-ok',
  running: 'bg-accent-soft text-accent',
  queued: 'bg-panel2 text-muted',
  waiting_approval: 'bg-warn-soft text-warn',
  paused: 'bg-warn-soft text-warn',
  failed: 'bg-danger-soft text-danger',
  cancelled: 'bg-panel2 text-muted',
  interrupted: 'bg-danger-soft text-danger',
  pending: 'bg-warn-soft text-warn',
  approved: 'bg-ok-soft text-ok',
  denied: 'bg-danger-soft text-danger',
  connected: 'bg-ok-soft text-ok',
  error: 'bg-danger-soft text-danger',
  unregistered: 'bg-panel2 text-muted',
  skipped: 'bg-panel2 text-muted',
  allow: 'bg-ok-soft text-ok',
  deny: 'bg-danger-soft text-danger',
  require_approval: 'bg-warn-soft text-warn',
  rate_limited: 'bg-warn-soft text-warn',
  pass: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  'not-configured': 'bg-panel2 text-muted',
  unreachable: 'bg-danger-soft text-danger',
  ready: 'bg-ok-soft text-ok',
  configured: 'bg-accent-soft text-accent',
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const cls = STATUS_STYLES[status] ?? 'bg-panel2 text-muted';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      {label ?? status.replaceAll('_', ' ')}
    </span>
  );
}

const RISK_STYLES: Record<string, string> = {
  low: 'bg-ok-soft text-ok',
  medium: 'bg-warn-soft text-warn',
  high: 'bg-danger-soft text-danger',
  critical: 'bg-danger-soft text-danger',
  unknown: 'bg-panel2 text-muted',
};

export function RiskBadge({ risk }: { risk: string }) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold ${RISK_STYLES[risk] ?? RISK_STYLES.unknown}`}>
      {risk}
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger' | 'accent';
}) {
  const tones = {
    default: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    danger: 'text-danger',
    accent: 'text-accent',
  } as const;
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted font-medium">{label}</div>
      <div className={`text-2xl font-semibold mt-1.5 tabular-nums ${tones[tone]}`}>{value}</div>
      {sub ? <div className="text-[12px] text-muted mt-1">{sub}</div> : null}
    </Card>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed border-border rounded-xl p-10 text-center">
      <div className="text-[15px] font-medium">{title}</div>
      {hint ? <div className="text-muted text-[13px] mt-1 max-w-md mx-auto">{hint}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="p-4 border-danger/40 bg-danger-soft">
      <div className="text-danger font-medium text-[13px]">Error: {message}</div>
      {onRetry ? (
        <button onClick={onRetry} className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-danger/40 text-danger hover:bg-danger/10">
          Retry
        </button>
      ) : null}
    </Card>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted text-[13px] p-6">
      <span className="inline-block w-3.5 h-3.5 border-2 border-border border-t-accent rounded-full animate-spin" />
      {label}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 overflow-y-auto bg-black/50" onClick={onClose}>
      <div
        className={`bg-panel border border-border rounded-xl shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} mt-8`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="font-semibold text-[15px]">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink text-lg leading-none px-1" aria-label="Close">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Input({ value, onChange, placeholder, className = '', type: inputType = 'text' }: { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; placeholder?: string; className?: string; type?: string }) {
  return <input type={inputType} value={value} onChange={onChange} className={`${inputCls} ${className}`} placeholder={placeholder} />;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  type = 'button',
  small = false,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
  className?: string;
}) {
  const variants = {
    primary: 'bg-accent text-white hover:opacity-90 disabled:opacity-40',
    secondary: 'bg-panel2 text-ink border border-border hover:border-accent/50 disabled:opacity-40',
    danger: 'bg-danger-soft text-danger border border-danger/30 hover:bg-danger/10 disabled:opacity-40',
    ghost: 'text-muted hover:text-ink disabled:opacity-40',
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg font-medium transition-none ${className} ${small ? 'text-[12px] px-2.5 py-1' : 'text-[13px] px-3.5 py-1.5'} ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block mb-3">
      <div className="text-[12px] font-medium text-muted mb-1">{label}</div>
      {children}
      {hint ? <div className="text-[11px] text-muted mt-1">{hint}</div> : null}
    </label>
  );
}

export const inputCls =
  'w-full bg-panel2 border border-border rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:border-accent';

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] ${className}`}>{children}</span>;
}

export function CodeBlock({ children, maxLines = 40 }: { children: string; maxLines?: number }) {
  const lines = children.split('\n');
  const shown = lines.slice(0, maxLines);
  return (
    <pre className="bg-panel2 border border-border rounded-lg p-3 overflow-x-auto text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
      {shown.join('\n')}
      {lines.length > maxLines ? `\n… +${lines.length - maxLines} lines` : ''}
    </pre>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted border-b border-border">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr
      className={`border-b border-border/60 last:border-0 ${onClick ? 'cursor-pointer hover:bg-panel2' : ''}`}
      onClick={onClick}
    >
      {children}
    </tr>
  );
}

export function Cell({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return <td className={`py-2.5 pr-4 ${className}`} onClick={onClick}>{children}</td>;
}
