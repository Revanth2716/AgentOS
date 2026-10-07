import { NavLink, Route, Routes } from 'react-router-dom';
import { usePoll, useTheme } from './lib/hooks.js';
import { api } from './lib/api.js';
import Dashboard from './pages/Dashboard.js';
import Agents from './pages/Agents.js';
import AgentDetail from './pages/AgentDetail.js';
import Runs from './pages/Runs.js';
import RunDetail from './pages/RunDetail.js';
import Approvals from './pages/Approvals.js';
import Workflows from './pages/Workflows.js';
import WorkflowDetail from './pages/WorkflowDetail.js';
import Tools from './pages/Tools.js';
import Policies from './pages/Policies.js';
import Evaluations from './pages/Evaluations.js';
import Metrics from './pages/Metrics.js';
import Settings from './pages/Settings.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '▦', end: true },
  { to: '/agents', label: 'Agents', icon: '◉' },
  { to: '/workflows', label: 'Workflows', icon: '⇄' },
  { to: '/runs', label: 'Runs', icon: '▷' },
  { to: '/approvals', label: 'Approvals', icon: '✓' },
  { to: '/tools', label: 'Tools', icon: '⚒' },
  { to: '/policies', label: 'Policies', icon: '⛨' },
  { to: '/evaluations', label: 'Evaluations', icon: '≡' },
  { to: '/metrics', label: 'Metrics', icon: '◔' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const { data: summary } = usePoll(() => api.summary(), 5_000);
  const pendingApprovals = summary?.policy.pendingApprovals ?? 0;

  return (
    <div className="min-h-full flex">
      <aside className="w-52 shrink-0 border-r border-border bg-panel flex flex-col sticky top-0 h-screen">
        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-accent text-white grid place-items-center font-bold text-[13px]">A</div>
            <div>
              <div className="font-semibold text-[14px] leading-none">AgentOS</div>
              <div className="text-[10px] text-muted mt-1 uppercase tracking-wider">control plane</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 py-3 px-2.5 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] ${
                  isActive ? 'bg-accent-soft text-accent font-medium' : 'text-muted hover:text-ink hover:bg-panel2'
                }`
              }
            >
              <span className="w-4 text-center opacity-70">{item.icon}</span>
              {item.label}
              {item.to === '/approvals' && pendingApprovals > 0 ? (
                <span className="ml-auto bg-warn text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {pendingApprovals}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-border space-y-2">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>{summary?.demoMode ? 'DEMO · $0.00' : 'LIVE'}</span>
            <button onClick={toggleTheme} className="px-2 py-1 rounded border border-border hover:border-accent/50" title="Toggle theme">
              {theme === 'dark' ? '☾ dark' : '☀ light'}
            </button>
          </div>
          <div className="text-[10px] text-muted truncate" title={JSON.stringify(summary?.cost)}>
            {summary ? `${summary.runs.total} runs · ${summary.agents.total} agents` : 'connecting…'}
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 p-6 max-w-[1400px]">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/workflows/:id" element={<WorkflowDetail />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/evaluations" element={<Evaluations />} />
          <Route path="/metrics" element={<Metrics />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
