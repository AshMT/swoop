import { useState, type ReactNode } from 'react';
import { CheckIcon, CopyIcon } from './Icons';

/** The ticket page's building blocks, shared by its panels. */

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Fact({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'warning' | 'danger' }) {
  const toneClass =
    tone === 'danger' ? 'text-eye-700 dark:text-eye-300 font-medium' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-slate-200';
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`mt-0.5 break-words ${mono ? 'font-mono text-xs' : ''} ${toneClass}`}>{value}</dd>
    </div>
  );
}

export function Callout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <div className="text-xs font-semibold text-slate-500">{title}</div>
      <div className="text-sm text-slate-800 dark:text-slate-200">{children}</div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-ghost text-xs"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
