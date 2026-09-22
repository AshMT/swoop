import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getSystemStatus, setToken } from '../api';
import { applyTheme, readTheme, resolveTheme, watchSystemTheme, writeTheme, type Theme } from '../lib/theme';
import { formatRelative } from '../lib/format';
import {
  CalibrationIcon,
  ClientsIcon,
  DashboardIcon,
  LogoutIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  SwoopLogo,
} from './Icons';
import { Alert } from './ui';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { to: '/calibration', label: 'Calibration', Icon: CalibrationIcon },
  { to: '/clients', label: 'Clients', Icon: ClientsIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
];

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
      className="btn-ghost w-full justify-start"
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
    <div className="border-t border-slate-700/60 px-4 py-3 text-xs text-slate-400">
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
  const handleLogout = () => {
    setToken(null);
    window.location.assign('/login');
  };

  return (
    <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
      <aside className="flex w-56 shrink-0 flex-col bg-slate-900 text-slate-100">
        <div className="flex items-center gap-2.5 border-b border-slate-700/60 px-4 py-4">
          <SwoopLogo className="h-8 w-8 text-swoop-600" />
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight">Swoop</div>
            <div className="truncate text-xs text-slate-400">AI ticket triage</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-2 py-3">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-swoop-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="space-y-1 px-2 pb-2">
          <ThemeToggle />
          <button onClick={handleLogout} className="btn-ghost w-full justify-start">
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
