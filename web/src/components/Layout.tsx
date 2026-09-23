import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getQueueSummary, getSystemStatus, setToken, type Role } from '../api';
import { roleAtLeast, useMe } from '../lib/session';
import { applyTheme, readTheme, resolveTheme, watchSystemTheme, writeTheme, type Theme } from '../lib/theme';
import { formatRelative } from '../lib/format';
import {
  ApprovalIcon,
  CalibrationIcon,
  ClientsIcon,
  IncidentIcon,
  LogIcon,
  LogoutIcon,
  MoonIcon,
  PeopleIcon,
  QueueIcon,
  SettingsIcon,
  SunIcon,
  SwoopLogo,
} from './Icons';
import { Alert } from './ui';

type Badge = 'queue' | 'approvals' | 'incidents';

const NAV: Array<{ to: string; label: string; Icon: (p: { className?: string }) => JSX.Element; min: Role; badge?: Badge }> = [
  { to: '/queue', label: 'Triage queue', Icon: QueueIcon, min: 'viewer', badge: 'queue' },
  { to: '/approvals', label: 'Approvals', Icon: ApprovalIcon, min: 'viewer', badge: 'approvals' },
  { to: '/incidents', label: 'Incidents', Icon: IncidentIcon, min: 'viewer', badge: 'incidents' },
  { to: '/log', label: 'Activity log', Icon: LogIcon, min: 'viewer' },
  { to: '/calibration', label: 'Calibration', Icon: CalibrationIcon, min: 'viewer' },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon, min: 'viewer' },
  { to: '/people', label: 'People', Icon: PeopleIcon, min: 'admin' },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, min: 'viewer' },
];

function useNavCounts(): Record<Badge, { count: number; urgent: boolean }> | null {
  const { data } = useQuery({
    queryKey: ['queue-summary'],
    queryFn: () => getQueueSummary({ days: 7 }).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });
  if (!data) return null;
  return {
    queue: { count: data.priorities.P1 + data.priorities.P2, urgent: data.priorities.P1 > 0 },
    approvals: { count: data.pendingApprovals, urgent: false },
    incidents: { count: data.openIncidents, urgent: data.openIncidents > 0 },
  };
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
    // A 'system' choice should track the OS if it changes while the tab is open.
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);

  const resolved = resolveTheme(theme);
  const next: Theme = resolved === 'dark' ? 'light' : 'dark';

  return (
    <button
      onClick={() => {
        setTheme(next);
        writeTheme(next);
      }}
      className="btn w-full justify-start text-slate-400 hover:bg-white/[0.04] hover:text-slate-100"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
      <span>{resolved === 'dark' ? 'Light theme' : 'Dark theme'}</span>
    </button>
  );
}

/**
 * Health strip.
 *
 * Poll failures used to be visible only in `docker logs`, so an operator whose
 * SuperOps token had expired saw an empty dashboard with no explanation. This
 * puts the reason on screen.
 */
function HealthBanner() {
  const [dismissed, setDismissed] = useState<string[]>([]);

  const { data } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => getSystemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  if (!data) return null;

  const warnings = data.warnings.filter((w) => !dismissed.includes(w));
  const pollerStopped = !data.poller.running;

  if (warnings.length === 0 && !pollerStopped) return null;

  return (
    <div className="space-y-2 border-b border-slate-200 bg-slate-50 px-6 py-3 dark:border-slate-800 dark:bg-slate-900/60">
      {pollerStopped && (
        <Alert tone="danger" title="The ticket poller is not running">
          No tickets are being classified. Check the server logs and restart Swoop.
        </Alert>
      )}
      {warnings.map((warning) => (
        <Alert key={warning} tone="warning" onDismiss={() => setDismissed((d) => [...d, warning])}>
          {warning}
        </Alert>
      ))}
    </div>
  );
}

function PollStatusFooter() {
  const { data } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => getSystemStatus().then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  const tenant = data?.tenants[0];

  return (
    <div className="border-t border-white/10 px-4 py-3 text-xs text-slate-400">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            !data
              ? 'bg-slate-500'
              : tenant?.lastPollStatus === 'error'
                ? 'bg-red-500'
                : tenant?.automationPaused
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'
          }`}
        />
        <span>
          {!data
            ? 'Status unknown'
            : tenant?.automationPaused
              ? 'Paused'
              : tenant?.lastPollStatus === 'error'
                ? 'Poll failed'
                : 'Polling'}
        </span>
      </div>
      {tenant && (
        <div className="mt-1 text-slate-500">Last poll {formatRelative(tenant.lastPollFinishedAt)}</div>
      )}
      {data && <div className="mt-1 text-slate-600">Swoop v{data.version}</div>}
    </div>
  );
}

export default function Layout() {
  const { data: me } = useMe();
  const counts = useNavCounts();

  const handleLogout = () => {
    setToken(null);
    window.location.assign('/login');
  };

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Ink-black, like the bird, with the sheen reserved for what is active. */}
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-slate-950 text-slate-100">
        <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
          <SwoopLogo className="h-9 w-9 shrink-0 drop-shadow" />
          <div className="min-w-0">
            <div className="text-lg font-semibold leading-tight tracking-tight">Swoop</div>
            <div className="truncate text-xs text-slate-400">Triage that swoops first</div>
          </div>
        </div>
        <div className="mx-4 h-px bg-sheen opacity-40" />

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {NAV.filter((item) => roleAtLeast(me?.role ?? 'viewer', item.min)).map(({ to, label, Icon, badge }) => {
            const count = badge && counts ? counts[badge] : null;
            return (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'sheen-edge bg-white/[0.07] text-white'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-100'
                  }`
                }
              >
                <Icon />
                <span className="flex-1">{label}</span>
                {count && count.count > 0 && (
                  <span
                    className={`tnum rounded-full px-1.5 text-[11px] font-semibold ${
                      count.urgent ? 'bg-eye-600 text-white' : 'bg-white/10 text-slate-200'
                    }`}
                  >
                    {count.count}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {me && (
          <div className="mx-2 mb-2 rounded-lg bg-white/[0.04] px-3 py-2">
            <div className="truncate text-sm font-medium text-slate-100">{me.displayName || me.email}</div>
            <div className="truncate text-xs capitalize text-slate-400">{me.role ?? 'viewer'}</div>
          </div>
        )}

        <div className="space-y-1 px-2 pb-2">
          <ThemeToggle />
          <button onClick={handleLogout} className="btn w-full justify-start text-slate-400 hover:bg-white/[0.04] hover:text-slate-100">
            <LogoutIcon />
            <span>Sign out</span>
          </button>
        </div>

        <PollStatusFooter />
      </aside>

      <main className="min-w-0 flex-1">
        <HealthBanner />
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
