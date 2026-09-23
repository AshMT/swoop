import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRunbook,
  deleteRunbook,
  errorMessage,
  getClients,
  getRunbooks,
  getTenants,
  searchRunbooks,
  syncKnowledgeBase,
  updateRunbook,
  type Runbook,
} from '../api';
import { Badge, ConfirmDialog, EmptyState, LoadingState, PageHeader, Spinner, useToast } from '../components/ui';
import { PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from '../components/Icons';
import { formatRelative } from '../lib/format';
import { useCan } from '../lib/session';

/**
 * How this MSP does things, per client or for everyone. Triage cites the
 * runbooks that match a ticket, and the investigation agent reads them before
 * recommending anything — so "Acme wants the office manager to approve new
 * starters" belongs here.
 */
export default function Knowledge() {
  const canEdit = useCan('reviewer');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const [scope, setScope] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Runbook | 'new' | null>(null);

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenant = tenants?.[0];
  const tenantId = tenant?.id;
  const { data: clients } = useQuery({
    queryKey: ['clients', tenantId],
    queryFn: () => getClients(tenantId).then((r) => r.data),
    enabled: Boolean(tenantId),
  });
  const clientNames = useMemo(() => new Map((clients ?? []).map((c) => [c.id, c.name])), [clients]);

  const { data: runbooks, isLoading } = useQuery({
    queryKey: ['runbooks', tenantId],
    queryFn: () => getRunbooks(tenantId!).then((r) => r.data),
    enabled: Boolean(tenantId),
  });

  const trimmed = query.trim();
  const { data: hits, isFetching: searching } = useQuery({
    queryKey: ['runbook-search', tenantId, trimmed, scope],
    queryFn: () =>
      searchRunbooks(tenantId!, trimmed, scope === 'general' ? { general: true } : scope === 'all' ? {} : { clientId: scope }).then((r) => r.data),
    enabled: Boolean(tenantId) && trimmed.length > 1,
  });

  const sync = useMutation({
    mutationFn: () => syncKnowledgeBase(tenantId!).then((r) => r.data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['runbooks'] });
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      if (!res.available) toast.info(res.error ?? 'This SuperOps instance has no knowledge base Swoop can read.');
      else toast.success(`Synced ${res.imported} article${res.imported === 1 ? '' : 's'} from SuperOps${res.removed ? `, removed ${res.removed}` : ''}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not sync')),
  });

  const visible = useMemo(() => {
    const all = runbooks ?? [];
    if (trimmed.length > 1 && hits) {
      const byId = new Map(all.map((r) => [r.id, r]));
      return hits.map((h) => byId.get(h.id)).filter((r): r is Runbook => Boolean(r));
    }
    if (scope === 'general') return all.filter((r) => !r.clientId);
    if (scope !== 'all') return all.filter((r) => r.clientId === scope || !r.clientId);
    return all;
  }, [runbooks, hits, trimmed, scope]);

  const selected = runbooks?.find((r) => r.id === openId) ?? null;
  const select = (id: string | null) => {
    setEditing(null);
    setParams(id ? { open: id } : {}, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Knowledge"
        description="Runbooks Swoop cites on tickets and reads before recommending a fix. Write how each client wants things done."
        actions={
          canEdit && (
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => sync.mutate()} disabled={sync.isPending || !tenantId}>
                {sync.isPending ? <Spinner /> : <RefreshIcon />} Sync SuperOps KB
              </button>
              <button className="btn-primary" onClick={() => setEditing('new')} disabled={!tenantId}>
                <PlusIcon /> New runbook
              </button>
            </div>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Search as a ticket would, e.g. “new starter laptop”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="input w-auto" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">All runbooks</option>
          <option value="general">General only</option>
          {clients?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} (and general)
            </option>
          ))}
        </select>
        {tenant?.kbLastSyncedAt && <span className="text-xs text-slate-400">SuperOps synced {formatRelative(tenant.kbLastSyncedAt)}</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="card overflow-hidden lg:col-span-2">
          {isLoading ? (
            <LoadingState />
          ) : visible.length === 0 ? (
            <EmptyState
              title={trimmed ? 'No runbook matches' : 'No runbooks yet'}
              description={
                trimmed
                  ? 'A ticket like that would get no runbook cited.'
                  : 'Write one for anything a technician would otherwise have to remember — who approves what at each client, naming rules, which groups mean which access.'
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {searching && <li className="px-4 py-2 text-xs text-slate-400">Searching…</li>}
              {visible.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => select(r.id)}
                    className={`block w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 ${r.id === openId ? 'bg-slate-50 dark:bg-slate-800/60' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">{r.title}</span>
                      {r.source === 'superops' && <Badge>SuperOps</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {r.clientId ? clientNames.get(r.clientId) ?? 'Unknown client' : 'All clients'} · {formatRelative(r.updatedAt)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-3">
          {editing ? (
            <RunbookEditor
              key={editing === 'new' ? 'new' : editing.id}
              tenantId={tenantId!}
              runbook={editing === 'new' ? null : editing}
              clients={clients ?? []}
              defaultClientId={scope !== 'all' && scope !== 'general' ? scope : null}
              onDone={(id) => {
                setEditing(null);
                if (id) setParams({ open: id }, { replace: true });
              }}
            />
          ) : selected ? (
            <RunbookView
              runbook={selected}
              clientName={selected.clientId ? clientNames.get(selected.clientId) ?? 'Unknown client' : null}
              canEdit={canEdit}
              onEdit={() => setEditing(selected)}
              onDeleted={() => select(null)}
            />
          ) : (
            <div className="card">
              <EmptyState title="Pick a runbook" description="Or write a new one. Client-specific runbooks rank above general ones for that client’s tickets." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunbookView({
  runbook,
  clientName,
  canEdit,
  onEdit,
  onDeleted,
}: {
  runbook: Runbook;
  clientName: string | null;
  canEdit: boolean;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteRunbook(runbook.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runbooks'] });
      toast.success('Runbook deleted');
      onDeleted();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not delete')),
  });
  const editable = canEdit && runbook.source === 'swoop';
  return (
    <article className="card p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">{runbook.title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {clientName ?? 'All clients'} · updated {formatRelative(runbook.updatedAt)}
            {runbook.updatedBy ? ` by ${runbook.updatedBy}` : ''}
          </p>
        </div>
        {editable && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onEdit}>
              Edit
            </button>
            <button className="btn-ghost text-eye-700 dark:text-eye-300" onClick={() => setConfirm(true)} aria-label="Delete">
              <TrashIcon />
            </button>
          </div>
        )}
      </div>
      {runbook.source === 'superops' && <p className="mb-3 text-xs text-slate-500">Synced from the SuperOps knowledge base — edit it there.</p>}
      {runbook.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {runbook.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800 dark:text-slate-200">{runbook.body}</pre>
      <ConfirmDialog
        open={confirm}
        destructive
        title="Delete this runbook?"
        description="Triage and the agent stop using it straight away."
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirm(false);
          remove.mutate();
        }}
        onCancel={() => setConfirm(false)}
      />
    </article>
  );
}

function RunbookEditor({
  tenantId,
  runbook,
  clients,
  defaultClientId,
  onDone,
}: {
  tenantId: string;
  runbook: Runbook | null;
  clients: Array<{ id: string; name: string }>;
  defaultClientId: string | null;
  onDone: (id: string | null) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(runbook?.title ?? '');
  const [body, setBody] = useState(runbook?.body ?? '');
  const [clientId, setClientId] = useState<string>(runbook ? runbook.clientId ?? '' : defaultClientId ?? '');
  const [tags, setTags] = useState(runbook?.tags.join(', ') ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!runbook) setClientId(defaultClientId ?? '');
  }, [defaultClientId, runbook]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const data = {
      title: title.trim(),
      body: body.trim(),
      clientId: clientId || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20),
    };
    try {
      let id = runbook?.id ?? null;
      if (runbook) await updateRunbook(runbook.id, data);
      else id = (await createRunbook({ tenantId, ...data })).data.id;
      await queryClient.invalidateQueries({ queryKey: ['runbooks'] });
      toast.success(runbook ? 'Runbook saved' : 'Runbook added');
      onDone(id);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <div>
        <label className="label" htmlFor="rb-title">
          Title
        </label>
        <input id="rb-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme — new starters" required minLength={3} />
      </div>
      <div>
        <label className="label" htmlFor="rb-client">
          Applies to
        </label>
        <select id="rb-client" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className="hint">A client’s own runbook is only ever shown on that client’s tickets.</p>
      </div>
      <div>
        <label className="label" htmlFor="rb-body">
          How it is done
        </label>
        <textarea
          id="rb-body"
          className="input min-h-[240px] font-mono text-xs"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          minLength={10}
          placeholder={'Who can ask for it, who approves, the exact group or licence names, and the steps.\n\ne.g. Finance share access: add to the "Finance" security group. The finance manager (jo@acme.com) must approve.'}
        />
        <p className="hint">Write names exactly as they appear in Microsoft 365 — the agent matches them. Never put passwords here.</p>
      </div>
      <div>
        <label className="label" htmlFor="rb-tags">
          Tags
        </label>
        <input id="rb-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="onboarding, licences" />
      </div>
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={saving || title.trim().length < 3 || body.trim().length < 10}>
          {saving ? <Spinner /> : null} {runbook ? 'Save' : 'Add runbook'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => onDone(runbook?.id ?? null)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
