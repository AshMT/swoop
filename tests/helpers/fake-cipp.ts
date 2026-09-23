/**
 * A stateful stand-in for CIPP, shaped after CIPP-API's own handlers: reads
 * return what ListUsers / ListUserGroups / ListGroups / ListLicenses return,
 * writes change the state and answer with `{ Results }` the way CIPP does —
 * including its habit of answering HTTP 200 for a failure.
 */
export interface FakeUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  accountEnabled: boolean;
  onPremisesSyncEnabled?: boolean;
  userType?: string;
  assignedLicenses: Array<{ skuId: string }>;
  lastPasswordChangeDateTime?: string;
}

export interface FakeGroup {
  id: string;
  displayName: string;
  mail?: string | null;
  mailEnabled: boolean;
  securityEnabled: boolean;
  groupTypes: string[];
  onPremisesSyncEnabled?: boolean;
  isAssignableToRole?: boolean;
  members: string[];
}

export interface FakeState {
  users: FakeUser[];
  groups: FakeGroup[];
  licences: Array<{ skuId: string; License: string; TotalLicenses: number; CountUsed: number }>;
  writes: Array<{ endpoint: string; body: unknown }>;
  reads: string[];
  /** Behaviour switches for failure-mode tests. */
  mode: { editGroupSilentNoop?: boolean; hangOn?: string; failOn?: string };
}

export function createFakeCipp(state: FakeState, base = 'https://cipp.test'): typeof fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/oauth2/v2.0/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (!url.href.startsWith(base)) throw new Error(`Unexpected fetch ${url.href}`);
    const endpoint = url.pathname.replace('/api/', '');
    const q = url.searchParams;
    const tenant = q.get('tenantFilter');

    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
      state.writes.push({ endpoint, body });
      if (state.mode.hangOn === endpoint) throw new Error('The operation was aborted due to timeout');
      if (state.mode.failOn === endpoint) return json({ Results: `Failed to do ${endpoint}. Error: Insufficient privileges` }, 500);
      const b = body as Record<string, unknown>;
      const user = (idOrUpn: unknown) =>
        state.users.find((u) => u.id === idOrUpn || u.userPrincipalName.toLowerCase() === String(idOrUpn).toLowerCase());
      switch (endpoint) {
        case 'ExecResetPass': {
          const u = user(b.ID);
          if (!u) return json({ Results: `Failed to reset password for ${b.ID}. Error: not found` }, 500);
          u.lastPasswordChangeDateTime = new Date().toISOString();
          return json({ Results: { resultText: `Successfully reset the password for ${u.displayName}. The new password is Swoop-Temp-123!`, copyField: 'Swoop-Temp-123!', state: 'success' } });
        }
        case 'ExecResetMFA':
          return json({ Results: `Successfully deleted MFA methods for ${b.ID}` });
        case 'ExecDisableUser': {
          const u = user(b.ID)!;
          u.accountEnabled = Boolean(b.Enable);
          return json({ Results: `Successfully set account enabled state to ${b.Enable} for ${b.ID}` });
        }
        case 'ExecRevokeSessions':
          return json({ Results: `Successfully revoked sessions for ${b.Username}` });
        case 'EditGroup': {
          const group = state.groups.find((g) => g.id === (b.groupId as { value: string }).value)!;
          const add = (b.AddMember as Array<{ value: string }> | undefined) ?? [];
          const remove = (b.RemoveMember as Array<{ value: string }> | undefined) ?? [];
          if (!state.mode.editGroupSilentNoop) {
            for (const m of add) if (state.users.some((u) => u.id === m.value)) group.members.push(m.value);
            for (const m of remove) group.members = group.members.filter((id) => id !== m.value);
          }
          return json({ Results: [...add.map((m) => `Success - Added member ${m.value} to ${group.displayName} group`), ...remove.map((m) => `Success - Removed member ${m.value} from ${group.displayName} group`)] });
        }
        case 'ExecBulkLicense': {
          const req = (body as Array<Record<string, unknown>>)[0];
          const u = user((req.userIds as string[])[0])!;
          if (req.LicenseOperation === 'Add') {
            for (const l of req.Licenses as Array<{ value: string }>) u.assignedLicenses.push({ skuId: l.value });
          } else {
            // Faithful to CIPP: removal reads LicensesToRemove only.
            const drop = ((req.LicensesToRemove as Array<{ value: string }> | undefined) ?? []).map((l) => l.value);
            u.assignedLicenses = u.assignedLicenses.filter((l) => !drop.includes(l.skuId));
          }
          return json({ Results: [`Successfully processed licence change for ${u.userPrincipalName}`] });
        }
        default:
          return json({ Results: 'Unknown endpoint' }, 404);
      }
    }

    state.reads.push(`${endpoint}?${q}`);
    switch (endpoint) {
      case 'ListTenants':
        return json([{ defaultDomainName: tenant ?? 'acme.onmicrosoft.com' }]);
      case 'ListUsers': {
        const id = q.get('UserID')?.toLowerCase();
        const u = state.users.find((x) => x.userPrincipalName.toLowerCase() === id || x.id === id);
        return u ? json([{ ...u, LicJoined: u.assignedLicenses.map((l) => state.licences.find((s) => s.skuId === l.skuId)?.License ?? l.skuId).join(', ') }]) : json({ error: 'Request_ResourceNotFound' }, 404);
      }
      case 'ListUserGroups': {
        const id = q.get('userId')!.toLowerCase();
        const u = state.users.find((x) => x.userPrincipalName.toLowerCase() === id || x.id === id);
        return json(state.groups.filter((g) => u && g.members.includes(u.id)).map((g) => ({ id: g.id, DisplayName: g.displayName, MailEnabled: g.mailEnabled, SecurityGroup: g.securityEnabled, GroupTypes: g.groupTypes.join(','), IsAssignableToRole: g.isAssignableToRole ?? false, OnPremisesSync: g.onPremisesSyncEnabled ?? false })));
      }
      case 'ListGroups':
        return json(state.groups.map(({ members: _m, ...g }) => g));
      case 'ListLicenses':
        return json(state.licences.map((l) => ({ ...l, CountUsed: String(l.CountUsed), TotalLicenses: String(l.TotalLicenses), CountAvailable: String(l.TotalLicenses - l.CountUsed), skuPartNumber: l.License })));
      case 'ListMFAUsers':
        return json(state.users.map((u) => ({ UPN: u.userPrincipalName, MFARegistration: true, MFAMethods: ['microsoftAuthenticator'] })));
      case 'ListUserSigninLogs':
        return json([{ createdDateTime: '2026-09-23T01:00:00Z', appDisplayName: 'Outlook', ipAddress: '1.2.3.4', status: { errorCode: 50126, failureReason: 'Invalid password' }, location: { city: 'Sydney', countryOrRegion: 'AU' } }]);
      default:
        return json([]);
    }
  }) as typeof fetch;
}

export function baseState(): FakeState {
  return {
    users: [
      { id: 'u-sam', userPrincipalName: 'sam@acme.com', displayName: 'Sam Smith', accountEnabled: true, assignedLicenses: [{ skuId: 'sku-bp' }] },
      { id: 'u-tom', userPrincipalName: 'tom@acme.com', displayName: 'Tom Baker', accountEnabled: true, assignedLicenses: [] },
      { id: 'u-sync', userPrincipalName: 'old@acme.com', displayName: 'Synced User', accountEnabled: true, onPremisesSyncEnabled: true, assignedLicenses: [] },
    ],
    groups: [
      { id: 'g-fin', displayName: 'Finance', mailEnabled: false, securityEnabled: true, groupTypes: [], members: [] },
      { id: 'g-fin-ro', displayName: 'Finance-ReadOnly', mailEnabled: false, securityEnabled: true, groupTypes: [], members: [] },
      { id: 'g-dyn', displayName: 'All Staff', mailEnabled: false, securityEnabled: true, groupTypes: ['DynamicMembership'], members: [] },
      { id: 'g-adm', displayName: 'Helpdesk Admins', mailEnabled: false, securityEnabled: true, groupTypes: [], isAssignableToRole: true, members: [] },
      { id: 'g-dup1', displayName: 'Sales', mailEnabled: true, securityEnabled: false, groupTypes: [], members: [] },
      { id: 'g-dup2', displayName: 'Sales', mailEnabled: false, securityEnabled: true, groupTypes: [], members: [] },
    ],
    licences: [
      { skuId: 'sku-bp', License: 'Microsoft 365 Business Premium', TotalLicenses: 10, CountUsed: 10 },
      { skuId: 'sku-bs', License: 'Microsoft 365 Business Standard', TotalLicenses: 5, CountUsed: 2 },
    ],
    writes: [],
    reads: [],
    mode: {},
  };
}
