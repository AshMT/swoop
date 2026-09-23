import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteUser,
  errorMessage,
  getAudit,
  getRoles,
  getUsers,
  inviteUser,
  revokeInvite,
  updateUser,
  type AuditEntry,
  type Role,
} from '../api';
import { Badge, ConfirmDialog, EmptyState, LoadingState, PageHeader, Spinner, useToast } from '../components/ui';
import { CheckIcon, CopyIcon, TrashIcon } from '../components/Icons';
import { formatDateTime, formatRelative, formatUntil } from '../lib/format';
import { useMe } from '../lib/session';

/** Who can sign in, what they can do, and what they have done. */
export default function People() {
  const [tab, setTab] = useState<'people' | 'audit'>('people');
  return (
    <div>
      <PageHeader title="People" description="Invite colleagues, set what each can do, and see who did what." />
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {(
          [
            ['people', 'People and invitations'],
            ['audit', 'Audit log'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id ? 'border-swoop-600 text-slate-900 dark:text-slate-100' : 'border-transparent text-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'people' ? <PeopleTab /> : <AuditTab />}
    </div>
  );
}

function PeopleTab() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => getRoles().then((r) => r.data), staleTime: Infinity });
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => getUsers().then((r) => r.data) });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('reviewer');
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; email: string } | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  const invite = useMutation({
    mutationFn: () => inviteUser(email.trim(), role),
    onSuccess: (res) => {
      setLink({ email: res.data.email, url: `${window.location.origin}${res.data.path}` });
      setCopied(false);
      setEmail('');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not create the invitation')),
  });
  const update = useMutation({
    mutationFn: (args: { id: string; role?: Role; disabled?: boolean }) => updateUser(args.id, args),
    onSuccess: () => {
      refresh();
      toast.success('Saved');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not update that person')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvite(id),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err, 'Could not revoke the invitation')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
      toast.success('Removed');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove that person')),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (email.trim()) invite.mutate();
  };

  if (isLoading || !data) return <LoadingState />;

  return (
    <div className="space-y-5">
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Invite someone</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Swoop makes a one-time link you send them yourself — in Teams, email, however you like. It works for 72 hours.
        </p>
        <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
          <input className="input min-w-[16rem] flex-1" type="email" placeholder="colleague@msp.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <button className="btn-primary" disabled={invite.isPending}>
            {invite.isPending ? <Spinner /> : null} Create link
          </button>
        </form>
        {roles && (
          <ul className="mt-3 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
            {roles.map((r) => (
              <li key={r.id}>
                <span className="font-medium text-slate-700 dark:text-slate-300">{r.label}</span> — {r.description}
              </li>
            ))}
          </ul>
        )}
        {link && (
          <div className="mt-4 rounded-lg bg-sheen-soft p-3">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
              Invitation for {link.email} — shown once, copy it now
            </div>
            <div className="mt-1.5 flex gap-2">
              <input className="input font-mono text-xs" readOnly value={link.url} onFocus={(e) => e.target.select()} />
              <button
                className="btn-secondary"
                onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setCopied(true))}
              >
                {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <table className="w-full">
          <thead className="border-b border-slate-200 dark:border-slate-800">
            <tr>
              <th className="th">Person</th>
              <th className="th">Role</th>
              <th className="th">Last sign-in</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.users.map((u) => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                  <td className="td">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{u.displayName || u.email}</div>
                    {u.displayName && <div className="text-xs text-slate-500">{u.email}</div>}
                    {u.disabled && <Badge tone="danger">Disabled</Badge>}
                    {self && <Badge tone="info">You</Badge>}
                  </td>
                  <td className="td">
                    <select
                      className="input w-auto py-1"
                      value={u.role ?? 'viewer'}
                      disabled={self}
                      onChange={(e) => update.mutate({ id: u.id, role: e.target.value as Role })}
                    >
                      {roles?.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="td text-xs">{formatRelative(u.lastLoginAt)}</td>
                  <td className="td text-right">
                    {!self && (
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost text-xs" onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button className="btn-ghost text-xs text-eye-700" onClick={() => setDeleting({ id: u.id, email: u.email })} aria-label={`Remove ${u.email}`}>
                          <TrashIcon />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {data.invites.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold dark:border-slate-800">Open invitations</h2>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="flex-1">{i.email}</span>
                <Badge>{i.role}</Badge>
                <span className="text-xs text-slate-500">expires {formatUntil(i.expiresAt)}</span>
                <button className="btn-ghost text-xs" onClick={() => revoke.mutate(i.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Remove ${deleting?.email}?`}
        description="They lose access immediately. Their past reviews and approvals keep their name."
        confirmLabel="Remove"
        destructive
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function describeAudit(entry: AuditEntry): string {
  const d = entry.detail ?? {};
  const s = (key: string) => (typeof d[key] === 'string' || typeof d[key] === 'number' ? String(d[key]) : '');
  switch (entry.action) {
    case 'approval.approve':
      return `Approved ${s('classification')} on ticket ${s('ticketId')} (${s('approvals')}/${s('required')})`;
    case 'approval.reject':
      return `Rejected ${s('classification')} on ticket ${s('ticketId')}${s('reason') ? ` — ${s('reason').replace(/_/g, ' ')}` : ''}`;
    case 'review.record':
      return `Marked ticket ${s('ticketId')} ${s('verdict')}`;
    case 'review.bulk':
      return `Bulk-marked ${s('count')} as ${s('verdict') || 'unreviewed'}`;
    case 'ticket.rerun':
      return `Re-ran triage on ticket ${s('ticketId')}`;
    case 'user.invite':
      return `Invited ${s('email')} as ${s('role')}`;
    case 'user.update':
      return `Changed ${s('email')}${s('role') ? ` to ${s('role')}` : ''}${d.disabled === true ? ' — disabled' : d.disabled === false ? ' — enabled' : ''}`;
    case 'tenant.update':
      return `Changed settings: ${Array.isArray(d.fields) ? (d.fields as string[]).join(', ') : ''}`;
    case 'client.update':
      return `Changed client: ${Array.isArray(d.fields) ? (d.fields as string[]).join(', ') : ''}`;
    default:
      return entry.action.replace(/[._]/g, ' ');
  }
}

function AuditTab() {
  const [filter, setFilter] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['audit', filter],
    queryFn: () => getAudit({ limit: 200, action: filter || undefined }).then((r) => r.data),
  });
  return (
    <div>
      <div className="mb-3 flex gap-2">
        <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Everything</option>
          <option value="approval">Approvals</option>
          <option value="review">Reviews</option>
          <option value="user">People</option>
          <option value="tenant">Settings</option>
          <option value="client">Clients</option>
          <option value="incident">Incidents</option>
          <option value="ticket">Re-runs</option>
        </select>
      </div>
      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingState />
        ) : !data || data.length === 0 ? (
          <EmptyState title="No entries yet" perched={false} />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <span className="w-40 shrink-0 text-xs text-slate-500" title={formatDateTime(entry.createdAt)}>
                  {formatDateTime(entry.createdAt)}
                </span>
                <span className="w-48 shrink-0 truncate font-medium text-slate-800 dark:text-slate-200">{entry.userEmail}</span>
                <span className="flex-1 text-slate-600 dark:text-slate-300">{describeAudit(entry)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
