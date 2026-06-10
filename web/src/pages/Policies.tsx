import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getPolicies, updatePolicy, getTenants, updateTenant,
  type ActionPolicy, type PolicyPermission,
} from '../api';
import api from '../api';

const PERMISSION_META: Record<PolicyPermission, { label: string; classes: string }> = {
  approval: { label: 'Approval needed', classes: 'bg-amber-50 text-amber-800 border-amber-300' },
  auto: { label: 'Auto (pre-approved)', classes: 'bg-green-50 text-green-800 border-green-300' },
  disabled: { label: 'Disabled', classes: 'bg-gray-100 text-gray-500 border-gray-300' },
};

function PermissionSelect({ policy, tenantId }: { policy: ActionPolicy; tenantId: string }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (permission: PolicyPermission) =>
      updatePolicy(policy.actionType, { tenantId, permission }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['policies'] }),
  });

  const meta = PERMISSION_META[policy.permission];
  return (
    <select
      value={policy.permission}
      onChange={(e) => mutation.mutate(e.target.value as PolicyPermission)}
      disabled={mutation.isPending}
      className={`text-xs font-medium border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-swoop-500 disabled:opacity-50 cursor-pointer ${meta.classes}`}
    >
      <option value="approval">Approval needed{policy.isDefault && policy.permission === 'approval' ? ' (default)' : ''}</option>
      <option value="auto">Auto (pre-approved)</option>
      <option value="disabled">Disabled</option>
    </select>
  );
}

function VerificationToggle({ policy, tenantId }: { policy: ActionPolicy; tenantId: string }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (requireVerification: boolean) =>
      updatePolicy(policy.actionType, { tenantId, requireVerification }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['policies'] }),
  });

  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={policy.requireVerification}
        onChange={(e) => mutation.mutate(e.target.checked)}
        disabled={mutation.isPending}
        className="w-4 h-4 rounded accent-swoop-600"
      />
      <span className="text-xs text-gray-600">{policy.requireVerification ? 'Required' : 'Not required'}</span>
    </label>
  );
}

export default function Policies() {
  const queryClient = useQueryClient();
  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => getTenants().then((r) => r.data) });
  const tenant = tenants?.[0];
  const tenantId = tenant?.id || '';

  const { data: policies = [], isLoading } = useQuery({
    queryKey: ['policies', tenantId],
    queryFn: () => getPolicies(tenantId).then((r) => r.data),
    enabled: !!tenantId,
  });

  const [thresholdPct, setThresholdPct] = useState<number | null>(null);
  const effectiveThreshold = thresholdPct ?? Math.round((tenant?.autoConfidenceMin ?? 0.9) * 100);

  const thresholdMutation = useMutation({
    mutationFn: (pct: number) => api.patch(`/tenants/${tenantId}`, { autoConfidenceMin: pct / 100 }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenants'] }),
  });

  const autoCount = policies.filter((p) => p.permission === 'auto').length;
  const disabledCount = policies.filter((p) => p.permission === 'disabled').length;

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Action Policies</h1>
        <p className="text-gray-500 text-sm mt-1">
          Set the permission level for every action Swoop can execute. Pre-approved actions run
          automatically; everything else waits for a human.
        </p>
      </div>

      {/* Auto-execution guardrails */}
      <div className="sticker p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-800">Auto-execution guardrails</h2>
            <p className="text-xs text-gray-500 mt-1 max-w-md">
              Pre-approved actions only execute automatically when AI confidence meets this threshold.
              High-sensitivity tickets <strong>always</strong> require human approval, regardless of policy.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-gray-600">Min confidence</label>
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={effectiveThreshold}
              onChange={(e) => setThresholdPct(parseInt(e.target.value, 10))}
              onMouseUp={() => thresholdPct !== null && thresholdMutation.mutate(thresholdPct)}
              onTouchEnd={() => thresholdPct !== null && thresholdMutation.mutate(thresholdPct)}
              className="w-36 accent-swoop-600"
            />
            <span className="text-sm font-bold text-gray-900 w-12">{effectiveThreshold}%</span>
          </div>
        </div>
        {(autoCount > 0 || disabledCount > 0) && (
          <div className="flex gap-2 mt-3">
            {autoCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 ring-1 ring-green-200">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                {autoCount} pre-approved
              </span>
            )}
            {disabledCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 ring-1 ring-gray-200">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                {disabledCount} disabled
              </span>
            )}
          </div>
        )}
      </div>

      {/* Policy catalog */}
      <div className="sticker overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-gray-400 text-sm">Loading policies...</div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">Identity verification</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Permission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {policies.map((policy) => (
                <tr key={policy.actionType} className="hover:bg-gray-50">
                  <td className="px-4 py-3 align-top whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{policy.label}</div>
                    <div className="text-xs text-gray-400 font-mono mt-0.5">{policy.actionType}</div>
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-gray-500 leading-relaxed max-w-md">
                    {policy.description}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <VerificationToggle policy={policy} tenantId={tenantId} />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <PermissionSelect policy={policy} tenantId={tenantId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-4">
        <strong>Approval needed</strong> — a technician reviews and approves before execution (default for all writes).{' '}
        <strong>Auto</strong> — pre-approved: executes immediately when confidence and sensitivity guardrails pass.{' '}
        <strong>Disabled</strong> — Swoop never executes this action; matching tickets are escalated to a human.
      </p>
    </div>
  );
}
