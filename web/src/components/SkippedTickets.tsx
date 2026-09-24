import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, getSkippedTickets, triageSkippedTicket, updateClient, type SkippedTicket } from '../api';
import { formatRelative } from '../lib/format';
import { useCan } from '../lib/session';
import { Spinner, useToast } from './ui';
import { ChevronDownIcon, ChevronRightIcon, ExternalIcon } from './Icons';

/**
 * Tickets Swoop saw in SuperOps but did not triage, because no enabled client
 * matched them — so a new ticket never just silently fails to appear. Each
 * one offers the fix: add the client, or enable it, then triage it now.
 */
export function SkippedTickets({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(true);
  const { data } = useQuery({
    queryKey: ['skipped', tenantId],
    queryFn: () => getSkippedTickets(tenantId).then((r) => r.data),
    refetchInterval: 30_000,
  });
  if (!data || data.length === 0) return null;

  return (
    <section className="card mb-5 overflow-hidden ring-1 ring-amber-200 dark:ring-amber-900">
      <button className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {data.length} ticket{data.length === 1 ? '' : 's'} not triaged
        </span>
        <span className="text-xs text-slate-500">Their client is not set up or not enabled in Swoop.</span>
      </button>
      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
          {data.map((t) => (
            <SkippedRow key={t.ticketId} ticket={t} tenantId={tenantId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SkippedRow({ ticket, tenantId }: { ticket: SkippedTicket; tenantId: string }) {
  const isAdmin = useCan('admin');
  const canTriage = useCan('reviewer');
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const from = ticket.superopsClientName || ticket.superopsClientId || 'no client in SuperOps';

  const enable = useMutation({
    mutationFn: () => updateClient(ticket.clientId!, { automationEnabled: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      toast.success(`${ticket.clientName} enabled — triaging the ticket`);
      triage.mutate();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not enable the client')),
  });

  const triage = useMutation({
    mutationFn: () => triageSkippedTicket(tenantId, ticket.ticketId).then((r) => r.data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['skipped', tenantId] });
      void queryClient.invalidateQueries({ queryKey: ['actions'] });
      void queryClient.invalidateQueries({ queryKey: ['queue-summary'] });
      toast.success('Triaged');
      if (res.actionLogId) navigate(`/tickets/${res.actionLogId}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not triage it')),
  });

  const addHref = `/clients?add=1&name=${encodeURIComponent(ticket.superopsClientName ?? '')}&companyId=${encodeURIComponent(ticket.superopsClientId ?? '')}`;
  const busy = enable.isPending || triage.isPending;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-slate-900 dark:text-slate-100">
          {ticket.displayId ? `#${ticket.displayId} ` : ''}
          {ticket.subject || '(no subject)'}
          {ticket.ticketUrl && (
            <a href={ticket.ticketUrl} target="_blank" rel="noreferrer" className="ml-1.5 inline-block align-middle text-slate-400 hover:text-slate-700" aria-label="Open in SuperOps">
              <ExternalIcon className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          From <span className="font-medium text-slate-700 dark:text-slate-300">{from}</span>
          {ticket.requesterEmail ? ` · ${ticket.requesterEmail}` : ''} · {formatRelative(ticket.firstSeenAt)} ·{' '}
          {ticket.reason === 'client_disabled'
            ? `${ticket.clientName} is added but not enabled`
            : 'no client in Swoop matches it'}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {ticket.reason === 'client_disabled' && isAdmin && ticket.clientId && (
          <button className="btn-primary text-xs" disabled={busy} onClick={() => enable.mutate()}>
            {busy ? <Spinner /> : null} Enable {ticket.clientName} and triage
          </button>
        )}
        {ticket.reason === 'no_client' && isAdmin && (
          <Link to={addHref} className="btn-primary text-xs">
            Add client
          </Link>
        )}
        {canTriage && (
          <button className="btn-secondary text-xs" disabled={busy} onClick={() => triage.mutate()} title="Once its client is added and enabled">
            {triage.isPending ? <Spinner /> : null} Triage now
          </button>
        )}
      </div>
    </li>
  );
}
