import { useEffect, useRef, useState, useCallback } from 'react';

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('agentos-theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('agentos-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return [theme, toggle];
}

/** Subscribes to an SSE endpoint; returns last event for re-render triggers. */
export function useSse(path: string | null): { connected: boolean; lastEvent: { type: string; data: Record<string, unknown> } | null } {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<{ type: string; data: Record<string, unknown> } | null>(null);
  useEffect(() => {
    if (!path) return;
    const es = new EventSource(path);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const handler = (type: string) => (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as Record<string, unknown>;
        setLastEvent({ type, data });
      } catch {
        /* ignore malformed frames */
      }
    };
    const types = [
      'task_received',
      'model_called',
      'model_completed',
      'tool_called',
      'tool_completed',
      'tool_failed',
      'policy_check',
      'policy_blocked',
      'approval_requested',
      'approval_granted',
      'approval_denied',
      'run_completed',
      'run_failed',
      'run_cancelled',
      'workflow_started',
      'workflow_node_started',
      'workflow_node_completed',
      'workflow_node_failed',
      'workflow_completed',
      'workflow_failed',
      'approval_requested',
      'retry',
    ];
    const listeners: [string, (e: MessageEvent<string>) => void][] = types.map((t) => [t, handler(t)]);
    for (const [t, fn] of listeners) es.addEventListener(t, fn);
    return () => {
      for (const [t, fn] of listeners) es.removeEventListener(t, fn);
      es.close();
      setConnected(false);
    };
  }, [path]);
  return { connected, lastEvent };
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { hour12: false });
}

export function fmtRelative(ts: number | null | undefined): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  if (delta < 1_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Keeps `value` fresh on an interval. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      try {
        const result = await fnRef.current();
        if (alive) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
      if (alive && ms > 0) timer = setTimeout(() => void loop(), ms);
    };
    void loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);
  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
