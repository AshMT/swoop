import './setup-env';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSkipped, forgetSkipped, listSkipped, recordSkipped } from '../src/services/skipped';
import type { PsaTicket } from '../src/services/psa/interface';
import type { Client } from '../src/types';

const ticket = (id: string, extra: Partial<PsaTicket> = {}): PsaTicket => ({
  ticketId: id, displayId: id.replace('T-', ''), subject: `Ticket ${id}`, body: '', status: null, priority: null,
  createdAt: null, clientId: 'acct-9', clientName: 'Acme Corp', requesterEmail: 'amy@acme.com', requesterName: null, ...extra,
});

beforeEach(() => clearSkipped());

describe('skipped tickets', () => {
  it('records why a ticket was passed over, newest first', () => {
    recordSkipped('t1', ticket('T-1'), null);
    recordSkipped('t1', ticket('T-2'), { id: 'c1', name: 'Acme' } as Client);
    const list = listSkipped('t1');
    expect(list.map((s) => s.ticket.ticketId)).toEqual(['T-2', 'T-1']);
    expect(list[0]).toMatchObject({ reason: 'client_disabled', clientId: 'c1', clientName: 'Acme' });
    expect(list[1]).toMatchObject({ reason: 'no_client', clientId: null });
  });

  it('keeps one entry per ticket, remembering when it was first seen', () => {
    recordSkipped('t1', ticket('T-1'), null);
    const first = listSkipped('t1')[0].firstSeenAt;
    recordSkipped('t1', ticket('T-1'), null);
    expect(listSkipped('t1')).toHaveLength(1);
    expect(listSkipped('t1')[0].firstSeenAt).toBe(first);
  });

  it('holds at most fifty per tenant and forgets on request', () => {
    for (let i = 0; i < 60; i++) recordSkipped('t1', ticket(`T-${i}`), null);
    expect(listSkipped('t1')).toHaveLength(50);
    expect(listSkipped('t1').at(-1)!.ticket.ticketId).toBe('T-10');
    forgetSkipped('t1', 'T-59');
    expect(listSkipped('t1')[0].ticket.ticketId).toBe('T-58');
    expect(listSkipped('t2')).toEqual([]);
  });
});
