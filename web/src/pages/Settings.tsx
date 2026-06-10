import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getTenants, testSuperOps, testAi, testCipp, getIntegrationStatus, type Tenant, type IntegrationCheck } from '../api';
import api from '../api';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type TestResult = { ok: boolean; error?: string; endpoint?: string } | null;
type ChipStatus = 'not-configured' | 'configured' | 'connected' | 'error' | 'checking';

function StatusChip({ status }: { status: ChipStatus }) {
  const ring = {
    'not-configured': 'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
    configured: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    connected: 'bg-green-50 text-green-700 ring-1 ring-green-200',
    error: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    checking: 'bg-blue-50 text-blue-600 ring-1 ring-blue-200',
  }[status];
  const dot = {
    'not-configured': 'bg-gray-400',
    configured: 'bg-amber-400',
    connected: 'bg-green-500',
    error: 'bg-red-500',
    checking: 'bg-blue-400 animate-pulse',
  }[status];
  const label = {
    'not-configured': 'Not configured',
    configured: 'Saved',
    connected: 'Connected ✓',
    error: 'Error',
    checking: 'Checking…',
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${ring}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      {label}
    </span>
  );
}

// Manual test wins (explicit, just-entered credentials).
// Live poll can only upgrade to 'connected' — never downgrade to 'error', since
// background checks can fail transiently (timeout, token refresh, network blip).
function deriveStatus(hasSaved: boolean, test: TestResult, live?: IntegrationCheck): ChipStatus {
  if (test?.ok === true) return 'connected';
  if (test?.ok === false) return 'error';
  if (live?.ok === true) return 'connected';
  if (live?.configured === false) return 'not-configured';
  if (hasSaved) return 'configured';
  return 'not-configured';
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCippGuide, setShowCippGuide] = useState(false);

  const refreshLiveStatus = () => queryClient.invalidateQueries({ queryKey: ['integration-status'] });

  // SuperOps fields
  const [subdomain, setSubdomain] = useState('');
  const [superopsKey, setSuperopsKey] = useState('');
  const [superopsRegion, setSuperopsRegion] = useState<'us' | 'eu'>('us');
  const [superopsTest, setSuperopsTest] = useState<TestResult>(null);
  const [superopsTesting, setSuperopsTesting] = useState(false);
  const [superopsSave, setSuperopsSave] = useState<SaveStatus>('idle');

  // AI fields
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiTest, setAiTest] = useState<TestResult>(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiSave, setAiSave] = useState<SaveStatus>('idle');

  // CIPP fields
  const [cippBaseUrl, setCippBaseUrl] = useState('');
  const [cippClientId, setCippClientId] = useState('');
  const [cippClientSecret, setCippClientSecret] = useState('');
  const [cippOauthTenantId, setCippOauthTenantId] = useState('');
  const [cippApiScope, setCippApiScope] = useState('');
  const [cippTest, setCippTest] = useState<TestResult>(null);
  const [cippTesting, setCippTesting] = useState(false);
  const [cippSave, setCippSave] = useState<SaveStatus>('idle');

  // Escalation
  const [escalationContact, setEscalationContact] = useState('');
  const [escalationSave, setEscalationSave] = useState<SaveStatus>('idle');

  useEffect(() => {
    getTenants()
      .then((res) => {
        const t = res.data[0];
        if (t) {
          setTenant(t);
          setSubdomain(t.superopsSubdomain || '');
          setSuperopsRegion((t.superopsRegion as 'us' | 'eu') || 'us');
          setAiBaseUrl(t.aiBaseUrl || '');
          setAiModel(t.aiModel || '');
          setCippBaseUrl(t.cippBaseUrl || '');
          setCippClientId(t.cippClientId || '');
          setCippOauthTenantId(t.cippOauthTenantId || '');
          setCippApiScope(t.cippApiScope || '');
          setEscalationContact(t.escalationContact || '');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  // Live health poll — re-checks every saved integration on an interval so chips stay current.
  const { data: liveStatus, dataUpdatedAt, isLoading: liveLoading } = useQuery({
    queryKey: ['integration-status', tenant?.id],
    queryFn: () => getIntegrationStatus(tenant!.id).then((r) => r.data),
    enabled: !!tenant?.id,
    refetchInterval: 30_000,
  });
  // True only on the very first fetch before any data has arrived
  const initialChecking = !!tenant?.id && liveLoading && !liveStatus;

  // Derived statuses — a fresh manual test wins, otherwise the live poll drives the chip.
  const superopsStatus = deriveStatus(!!tenant?.superopsSubdomain, superopsTest, liveStatus?.superops);
  const aiStatus = deriveStatus(!!(tenant?.aiBaseUrl && tenant?.aiModel), aiTest, liveStatus?.ai);
  const cippStatus = deriveStatus(
    !!(tenant?.cippBaseUrl && tenant?.cippClientId && tenant?.cippOauthTenantId),
    cippTest,
    liveStatus?.cipp,
  );

  const handleSubdomainChange = (val: string) => {
    const clean = val.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
    setSubdomain(clean);
    setSuperopsTest(null);
  };

  const handleTestSuperops = async () => {
    if (!subdomain) return;
    setSuperopsTesting(true);
    setSuperopsTest(null);
    try {
      const res = await testSuperOps(subdomain.trim(), superopsKey.trim(), superopsRegion);
      setSuperopsTest(res.data as TestResult);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Request failed';
      setSuperopsTest({ ok: false, error: msg });
    } finally {
      setSuperopsTesting(false);
    }
  };

  const handleSaveSuperops = async () => {
    if (!tenant) return;
    setSuperopsSave('saving');
    try {
      const body: Record<string, string> = { superopsSubdomain: subdomain.trim(), superopsRegion };
      if (superopsKey.trim()) body.superopsApiKey = superopsKey.trim();
      await api.patch(`/tenants/${tenant.id}`, body);
      setSuperopsSave('saved');
      setTenant({ ...tenant, superopsSubdomain: subdomain.trim(), superopsRegion });
      setSuperopsKey('');
      refreshLiveStatus();
      setTimeout(() => setSuperopsSave('idle'), 2500);
    } catch {
      setSuperopsSave('error');
      setTimeout(() => setSuperopsSave('idle'), 3000);
    }
  };

  const handleTestAi = async () => {
    if (!aiBaseUrl || !aiModel) return;
    setAiTesting(true);
    setAiTest(null);
    try {
      const res = await testAi(aiBaseUrl.trim(), aiApiKey.trim(), aiModel.trim());
      setAiTest({ ok: res.data.ok });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Request failed';
      setAiTest({ ok: false, error: msg });
    } finally {
      setAiTesting(false);
    }
  };

  const handleSaveAi = async () => {
    if (!tenant) return;
    setAiSave('saving');
    try {
      const body: Record<string, string | null> = {
        aiBaseUrl: aiBaseUrl.trim() || null,
        aiModel: aiModel.trim() || null,
      };
      if (aiApiKey.trim()) body.aiApiKey = aiApiKey.trim();
      await api.patch(`/tenants/${tenant.id}`, body);
      setAiSave('saved');
      setTenant({ ...tenant, aiBaseUrl: aiBaseUrl.trim() || null, aiModel: aiModel.trim() || null });
      setAiApiKey('');
      refreshLiveStatus();
      setTimeout(() => setAiSave('idle'), 2500);
    } catch {
      setAiSave('error');
      setTimeout(() => setAiSave('idle'), 3000);
    }
  };

  const handleSaveEscalation = async () => {
    if (!tenant) return;
    setEscalationSave('saving');
    try {
      await api.patch(`/tenants/${tenant.id}`, { escalationContact: escalationContact.trim() || null });
      setEscalationSave('saved');
      setTenant({ ...tenant, escalationContact: escalationContact.trim() || null });
      setTimeout(() => setEscalationSave('idle'), 2500);
    } catch {
      setEscalationSave('error');
      setTimeout(() => setEscalationSave('idle'), 3000);
    }
  };

  const handleTestCipp = async () => {
    if (!tenant) return;
    setCippTesting(true);
    setCippTest(null);
    try {
      const res = await testCipp(tenant.id);
      setCippTest(res.data);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Request failed';
      setCippTest({ ok: false, error: msg });
    } finally {
      setCippTesting(false);
    }
  };

  const handleSaveCipp = async () => {
    if (!tenant) return;
    setCippSave('saving');
    try {
      const body: Record<string, string | null> = {
        cippBaseUrl: cippBaseUrl.trim() || null,
        cippClientId: cippClientId.trim() || null,
        cippOauthTenantId: cippOauthTenantId.trim() || null,
        cippApiScope: cippApiScope.trim() || null,
      };
      // Only send the secret if a new value was entered — omitting it keeps the existing stored secret
      if (cippClientSecret.trim()) body.cippClientSecret = cippClientSecret.trim();
      await api.patch(`/tenants/${tenant.id}`, body);
      setCippSave('saved');
      setTenant({
        ...tenant,
        cippBaseUrl: cippBaseUrl.trim() || null,
        cippClientId: cippClientId.trim() || null,
        cippOauthTenantId: cippOauthTenantId.trim() || null,
        cippApiScope: cippApiScope.trim() || null,
      });
      setCippClientSecret('');
      refreshLiveStatus();
      setTimeout(() => setCippSave('idle'), 2500);
    } catch {
      setCippSave('error');
      setTimeout(() => setCippSave('idle'), 3000);
    }
  };

  if (loading) return <div className="p-8 text-gray-400 text-sm">Loading...</div>;
  if (!tenant) return <div className="p-8 text-red-500 text-sm">No tenant found.</div>;

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-6">Configure your integrations and AI provider.</p>

      {/* Integration status overview */}
      <div className="sticker p-4 mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Integration Status</p>
          {liveStatus && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              Live · checked {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              { label: 'SuperOps', status: initialChecking && !!tenant?.superopsSubdomain ? 'checking' : superopsStatus },
              { label: 'AI Provider', status: initialChecking && !!(tenant?.aiBaseUrl && tenant?.aiModel) ? 'checking' : aiStatus },
              { label: 'CIPP', status: initialChecking && !!(tenant?.cippBaseUrl && tenant?.cippClientId) ? 'checking' : cippStatus },
            ] as { label: string; status: ChipStatus }[]
          ).map(({ label, status }) => (
            <div key={label} className="flex flex-col items-center gap-1.5 py-2 px-3 rounded-lg bg-gray-50 border border-gray-100">
              <span className="text-xs font-medium text-gray-600">{label}</span>
              <StatusChip status={status} />
            </div>
          ))}
        </div>
      </div>

      {/* SuperOps section */}
      <section className="sticker p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">SuperOps Connection</h2>
          <StatusChip status={superopsStatus} />
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subdomain</label>
            <input
              type="text"
              value={subdomain}
              onChange={(e) => handleSubdomainChange(e.target.value)}
              placeholder="yourcompany"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">Just your subdomain — e.g. <code>mightyit</code> (not the full URL)</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Data centre</label>
            <div className="flex gap-4">
              {(['us', 'eu'] as const).map((r) => (
                <label key={r} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="region"
                    value={r}
                    checked={superopsRegion === r}
                    onChange={() => { setSuperopsRegion(r); setSuperopsTest(null); }}
                    className="accent-swoop-600"
                  />
                  <span className="text-sm text-gray-700">{r === 'us' ? 'US / Global' : 'EU'}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              API Key <span className="text-gray-400 font-normal">(leave blank to keep existing)</span>
            </label>
            <input
              type="password"
              value={superopsKey}
              onChange={(e) => { setSuperopsKey(e.target.value); setSuperopsTest(null); }}
              placeholder="Enter new API key to update"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
          </div>

          {superopsTest && (
            <div className={`rounded-md px-4 py-3 text-sm ${superopsTest.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
              {superopsTest.ok ? (
                <span>Connected successfully{superopsTest.endpoint ? ` — ${superopsTest.endpoint}` : ''}</span>
              ) : (
                <div>
                  <div className="font-medium">Connection failed</div>
                  {superopsTest.error && <div className="mt-1">{superopsTest.error}</div>}
                  {superopsTest.endpoint && <div className="mt-1 text-xs opacity-75">Tried: {superopsTest.endpoint}</div>}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleTestSuperops}
              disabled={!subdomain || superopsTesting}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {superopsTesting ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              onClick={handleSaveSuperops}
              disabled={!subdomain || superopsSave === 'saving'}
              className="px-4 py-2 text-sm bg-swoop-600 text-white rounded-md hover:bg-swoop-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {superopsSave === 'saving' ? 'Saving…' : superopsSave === 'saved' ? 'Saved ✓' : superopsSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {/* AI section */}
      <section className="sticker p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">AI Provider</h2>
          <StatusChip status={aiStatus} />
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
            <input
              type="url"
              value={aiBaseUrl}
              onChange={(e) => { setAiBaseUrl(e.target.value); setAiTest(null); }}
              placeholder="http://192.168.1.x:11434"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">Ollama: <code>http://192.168.1.x:11434</code> — <code>/v1</code> is added automatically</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              API Key <span className="text-gray-400 font-normal">(leave blank to keep existing or if not required)</span>
            </label>
            <input
              type="password"
              value={aiApiKey}
              onChange={(e) => { setAiApiKey(e.target.value); setAiTest(null); }}
              placeholder="sk-… or leave blank for Ollama"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <input
              type="text"
              value={aiModel}
              onChange={(e) => { setAiModel(e.target.value); setAiTest(null); }}
              placeholder="llama3, gpt-4o-mini, mistral…"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
          </div>

          {aiTest && (
            <div className={`rounded-md px-4 py-3 text-sm ${aiTest.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
              {aiTest.ok ? 'AI connection successful — model responded correctly.' : (
                <div>
                  <div className="font-medium">AI connection failed</div>
                  {aiTest.error && <div className="mt-1">{aiTest.error}</div>}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleTestAi}
              disabled={!aiBaseUrl || !aiModel || aiTesting}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {aiTesting ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              onClick={handleSaveAi}
              disabled={!aiBaseUrl || !aiModel || aiSave === 'saving'}
              className="px-4 py-2 text-sm bg-swoop-600 text-white rounded-md hover:bg-swoop-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {aiSave === 'saving' ? 'Saving…' : aiSave === 'saved' ? 'Saved ✓' : aiSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {/* CIPP section */}
      <section className="sticker p-6 mb-8">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-gray-800">CIPP Integration</h2>
          <StatusChip status={cippStatus} />
        </div>
        <p className="text-sm text-gray-500 mb-4">Connect to your CIPP instance to enable automated M365 action execution.</p>

        {/* Setup guide */}
        <div className="mb-5 rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setShowCippGuide(!showCippGuide)}
            className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              How to connect CIPP
            </span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${showCippGuide ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showCippGuide && (
            <div className="px-4 py-4 bg-white border-t border-gray-200">
              <ol className="space-y-3 text-sm text-gray-700">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">1</span>
                  <span>In CIPP, go to <strong>Settings → Backend → CIPP-API</strong> (or <strong>Integrations → CIPP-API</strong>). Copy the <strong>API URL</strong> shown at the top of that page.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">2</span>
                  <span>Click <strong>Add API Client</strong>. Name it <code className="bg-gray-100 px-1 rounded">swoop</code>. After saving, copy the <strong>Client ID</strong> from the client row.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">3</span>
                  <span>Click <strong>⋯ → Reset Application Secret</strong> on the swoop client row. Copy the secret — it's only shown once.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">4</span>
                  <span>Your <strong>MSP Azure Tenant ID</strong> is in <strong>Azure Entra admin centre → Overview → Tenant ID</strong>. This is your partner tenant, not a customer's.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">5</span>
                  <span>On the swoop client row → <strong>⋯ → Copy API Scope</strong>. Paste that into <strong>API Scope</strong> below — it's the resource the token targets and is usually a <em>different</em> GUID than the Client ID.</span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-ink text-white text-xs flex items-center justify-center font-bold mt-0.5">6</span>
                  <span>Paste all values below, click <strong>Save</strong>, then <strong>Test Connection</strong>.</span>
                </li>
              </ol>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">CIPP API URL</label>
            <input
              type="url"
              value={cippBaseUrl}
              onChange={(e) => { setCippBaseUrl(e.target.value); setCippTest(null); }}
              placeholder="https://cippmbwij.azurewebsites.net"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">The Azure Function App URL from the CIPP-API page</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
            <input
              type="text"
              value={cippClientId}
              onChange={(e) => { setCippClientId(e.target.value); setCippTest(null); }}
              placeholder="36b5f3c3-f5a0-4a3c-88b9-4402e069c7da"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Client Secret <span className="text-gray-400 font-normal">(leave blank to keep existing)</span>
            </label>
            <input
              type="password"
              value={cippClientSecret}
              onChange={(e) => { setCippClientSecret(e.target.value); setCippTest(null); }}
              placeholder={tenant.cippClientId ? '••••••••  (already set)' : 'Reset Application Secret in CIPP to get this'}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">MSP Azure Tenant ID</label>
            <input
              type="text"
              value={cippOauthTenantId}
              onChange={(e) => { setCippOauthTenantId(e.target.value); setCippTest(null); }}
              placeholder="fe23cefe-51b6-4021-a7e0-38dd7cd0a582"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">Your MSP's Azure AD tenant ID — Entra admin centre → Overview</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Scope</label>
            <input
              type="text"
              value={cippApiScope}
              onChange={(e) => { setCippApiScope(e.target.value); setCippTest(null); }}
              placeholder="api://<guid from Copy API Scope>/.default"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Paste the <em>exact</em> value from CIPP → the swoop client's <strong>⋯ → Copy API Scope</strong>.
              Leave blank to default to <code>api://&lt;Client ID&gt;/.default</code>.
            </p>
          </div>

          {cippTest && (
            <div className={`rounded-md px-4 py-3 text-sm ${cippTest.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
              {cippTest.ok ? 'CIPP connected successfully.' : (
                <div>
                  <div className="font-medium">CIPP connection failed</div>
                  {cippTest.error && <div className="mt-1 font-mono text-xs whitespace-pre-wrap break-all">{cippTest.error}</div>}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleTestCipp}
              disabled={!tenant?.cippBaseUrl || cippTesting}
              className="px-4 py-2 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cippTesting ? 'Testing…' : 'Test Connection'}
            </button>
            <button
              onClick={handleSaveCipp}
              disabled={(!cippBaseUrl && !cippClientId && !cippClientSecret && !cippOauthTenantId) || cippSave === 'saving'}
              className="px-4 py-2 text-sm bg-swoop-600 text-white rounded-md hover:bg-swoop-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cippSave === 'saving' ? 'Saving…' : cippSave === 'saved' ? 'Saved ✓' : cippSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {/* Escalation section */}
      <section className="sticker p-6 mb-8">
        <h2 className="text-base font-semibold text-gray-800 mb-1">Escalation</h2>
        <p className="text-xs text-gray-500 mb-4">
          When Swoop can't handle a ticket it posts an internal escalation note on the ticket.
          Set a contact below and the note will start with an @mention so the right tech gets pinged.
        </p>
        <div className="max-w-md">
          <label className="block text-sm font-medium text-gray-700 mb-1">Escalation contact</label>
          <input
            type="text"
            value={escalationContact}
            onChange={(e) => setEscalationContact(e.target.value)}
            placeholder="e.g. Jordan Smith"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
          />
          <p className="text-xs text-gray-400 mt-1">
            Name or handle as it appears in SuperOps — used as "@name" in escalation notes. Leave blank to skip the mention.
          </p>
          <div className="mt-3">
            <button
              onClick={handleSaveEscalation}
              disabled={escalationSave === 'saving'}
              className="px-4 py-2 bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg"
            >
              {escalationSave === 'saving' ? 'Saving…' : escalationSave === 'saved' ? 'Saved ✓' : escalationSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      {/* Tenant info */}
      <section className="sticker p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-3">Tenant Info</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-4">
            <dt className="text-gray-500 w-32 shrink-0">Name</dt>
            <dd className="text-gray-800">{tenant.name}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="text-gray-500 w-32 shrink-0">Slug</dt>
            <dd className="text-gray-800 font-mono">{tenant.slug}</dd>
          </div>
          <div className="flex gap-4">
            <dt className="text-gray-500 w-32 shrink-0">Tenant ID</dt>
            <dd className="text-gray-800 font-mono text-xs">{tenant.id}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
