import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertIcon, CheckIcon, InfoIcon, MagpieGlyph, XIcon } from './Icons';
import type { ApprovalState, TriageSignal } from '../api';

// ─── Badges ───────────────────────────────────────────────────────────────────

/**
 * Colour groups the classifications by what the technician has to do:
 * escalations and follow-ups are the ones needing a human, and the destructive
 * or access-granting actions are visually distinct from the routine ones.
 */
const CLASSIFICATION_STYLES: Record<string, string> = {
  password_reset: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  mfa_reset: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  group_add: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  group_remove: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  license_assign: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  license_remove: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300',
  account_disable: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  account_enable: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300',
  mailbox_permission: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  ESCALATE: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  FOLLOW_UP: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300',
};

const NEUTRAL = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

export function ClassificationBadge({ value, label }: { value: string | null; label?: string }) {
  const style = value ? (CLASSIFICATION_STYLES[value] ?? NEUTRAL) : NEUTRAL;
  return <span className={`badge ${style}`}>{label ?? value ?? 'unclassified'}</span>;
}

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: NEUTRAL,
    success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
    danger: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  };
  return <span className={`badge ${tones[tone]} ${className}`}>{children}</span>;
}

// ─── Confidence ───────────────────────────────────────────────────────────────

export function ConfidenceBar({ value, threshold }: { value: number | null; threshold?: number | null }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-slate-400 dark:text-slate-500">—</span>;
  }
  const pct = Math.round(value * 100);
  const floor = (threshold ?? 0.75) * 100;
  const colour = pct >= floor ? 'bg-emerald-500' : pct >= floor - 15 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="flex items-center gap-2" title={`${pct}% confidence`}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tnum text-xs text-slate-600 dark:text-slate-400">{pct}%</span>
    </div>
  );
}

// ─── Layout primitives ────────────────────────────────────────────────────────

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const tones: Record<string, string> = {
    neutral: 'text-slate-900 dark:text-slate-50',
    success: 'text-emerald-600 dark:text-emerald-400',
    warning: 'text-amber-600 dark:text-amber-400',
    danger: 'text-red-600 dark:text-red-400',
  };
  return (
    <div className="card p-4">
      <div className={`tnum text-2xl font-semibold ${tones[tone]}`}>{value}</div>
      <div className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      {hint && <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">{hint}</div>}
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/** A magpie gliding back and forth — the loading state, in Swoop's own voice. */
export function LoadingState({ label = 'Swooping in' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-slate-400 dark:text-slate-500" role="status">
      <MagpieGlyph className="h-7 w-7 animate-glide text-slate-800 dark:text-slate-200" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  perched = true,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Show the resting magpie. Off for compact empty states inside cards. */
  perched?: boolean;
}) {
  return (
    <div className="px-6 py-14 text-center">
      {perched && (
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sheen-soft">
          <MagpieGlyph className="h-7 w-7 text-slate-800 dark:text-slate-200" />
        </div>
      )}
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">{description}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// ─── Triage ───────────────────────────────────────────────────────────────────

const PRIORITY_STYLES: Record<string, string> = {
  P1: 'bg-eye-600 text-white ring-1 ring-eye-700 dark:bg-eye-600 dark:ring-eye-500',
  P2: 'bg-amber-400 text-slate-950 ring-1 ring-amber-500 dark:bg-amber-500',
  P3: 'bg-swoop-100 text-swoop-900 ring-1 ring-swoop-200 dark:bg-swoop-950 dark:text-swoop-200 dark:ring-swoop-800',
  P4: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
};

const PRIORITY_NAMES: Record<string, string> = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };

export function PriorityBadge({ value, showLabel = false }: { value: string | null | undefined; showLabel?: boolean }) {
  if (!value) return <span className="badge bg-slate-100 text-slate-400 dark:bg-slate-800">—</span>;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold tnum ${PRIORITY_STYLES[value] ?? PRIORITY_STYLES.P4}`}
      title={`${value} ${PRIORITY_NAMES[value] ?? ''}`}
    >
      {value}
      {showLabel && <span className="font-medium">{PRIORITY_NAMES[value]}</span>}
    </span>
  );
}

const APPROVAL_STYLES: Record<ApprovalState, { tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; label: string }> = {
  not_required: { tone: 'neutral', label: 'No action' },
  pending: { tone: 'warning', label: 'Awaiting approval' },
  approved: { tone: 'success', label: 'Approved' },
  auto_approved: { tone: 'success', label: 'Auto-approved' },
  rejected: { tone: 'danger', label: 'Rejected' },
  expired: { tone: 'neutral', label: 'Expired' },
  superseded: { tone: 'neutral', label: 'Superseded' },
};

export function ApprovalBadge({ state, required }: { state: ApprovalState | null | undefined; required?: number | null }) {
  if (!state || state === 'not_required') return null;
  const style = APPROVAL_STYLES[state];
  return (
    <Badge tone={style.tone}>
      {style.label}
      {state === 'pending' && required === 2 ? ' ×2' : ''}
    </Badge>
  );
}

const SIGNAL_STYLES: Record<TriageSignal['severity'], string> = {
  critical: 'bg-eye-50 text-eye-800 ring-1 ring-eye-200 dark:bg-eye-900/40 dark:text-eye-200 dark:ring-eye-800',
  warn: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-200 dark:ring-amber-900',
  info: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
};

export function SignalChips({
  signals,
  max = 3,
  minSeverity = 'info',
}: {
  signals: TriageSignal[] | null | undefined;
  max?: number;
  minSeverity?: TriageSignal['severity'];
}) {
  const order = { critical: 0, warn: 1, info: 2 };
  const list = (signals ?? [])
    .filter((s) => order[s.severity] <= order[minSeverity])
    .sort((a, b) => order[a.severity] - order[b.severity]);
  if (list.length === 0) return null;
  const shown = list.slice(0, max);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((signal) => (
        <span
          key={signal.id}
          title={signal.detail}
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${SIGNAL_STYLES[signal.severity]}`}
        >
          {signal.label}
        </span>
      ))}
      {list.length > shown.length && (
        <span className="text-[11px] text-slate-400" title={list.slice(max).map((s) => s.label).join(', ')}>
          +{list.length - shown.length}
        </span>
      )}
    </span>
  );
}

export function SignalList({ signals }: { signals: TriageSignal[] | null | undefined }) {
  const order = { critical: 0, warn: 1, info: 2 };
  const list = [...(signals ?? [])].sort((a, b) => order[a.severity] - order[b.severity]);
  if (list.length === 0) return <p className="text-sm text-slate-500 dark:text-slate-400">Nothing unusual.</p>;
  return (
    <ul className="space-y-2">
      {list.map((signal) => (
        <li key={signal.id} className={`rounded-lg px-3 py-2 text-sm ${SIGNAL_STYLES[signal.severity]}`}>
          <div className="font-medium">{signal.label}</div>
          <div className="text-xs opacity-80">{signal.detail}</div>
        </li>
      ))}
    </ul>
  );
}

export function Alert({
  tone,
  title,
  children,
  onDismiss,
}: {
  tone: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    info: {
      box: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-200',
      Icon: InfoIcon,
    },
    warning: {
      box: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
      Icon: AlertIcon,
    },
    danger: {
      box: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200',
      Icon: AlertIcon,
    },
    success: {
      box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
      Icon: CheckIcon,
    },
  }[tone];

  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${tones.box}`} role="alert">
      <tones.Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          <XIcon />
        </button>
      )}
    </div>
  );
}

/** A labelled on/off switch. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
          checked ? 'bg-swoop-600' : 'bg-slate-300 dark:bg-slate-700'
        } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-slate-700 dark:text-slate-300">{label}</span>}
          {description && (
            <span className="block text-xs text-slate-500 dark:text-slate-400">{description}</span>
          )}
        </span>
      )}
    </label>
  );
}

// ─── Toasts ───────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  tone: 'info' | 'success' | 'danger';
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi>({
  success: () => {},
  error: () => {},
  info: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    // Errors stay longer: they usually carry something the operator must read.
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, tone === 'danger' ? 8000 : 3500);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('danger', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto animate-slide-up">
            <Alert tone={toast.tone === 'danger' ? 'danger' : toast.tone === 'success' ? 'success' : 'info'}>
              {toast.message}
            </Alert>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 animate-fade-in">
      <div role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-md p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
        {description && <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{description}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={destructive ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
