import { useEffect, useState } from 'react';
import { getTenants, testSuperOps, testAi, type Tenant } from '../api';
import api from '../api';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type TestResult = { ok: boolean; error?: string; endpoint?: string } | null;

export default function Settings() {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);

  // SuperOps fields
  const [subdomain, setSubdomain] = useState('');
  const [superopsKey, setSuperopsKey] = useState('');
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

  useEffect(() => {
    getTenants()
      .then((res) => {
        const t = res.data[0];
        if (t) {
          setTenant(t);
          setSubdomain(t.superopsSubdomain || '');
          setAiBaseUrl(t.aiBaseUrl || '');
          setAiModel(t.aiModel || '');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSubdomainChange = (val: string) => {
    const clean = val
      .replace(/^https?:\/\//, '')
      .replace(/\.superops\.ai.*$/, '');
    setSubdomain(clean);
    setSuperopsTest(null);
  };

  const handleTestSuperops = async () => {
    if (!subdomain) return;
    setSuperopsTesting(true);
    setSuperopsTest(null);
    try {
      const res = await testSuperOps(subdomain.trim(), superopsKey.trim());
      setSuperopsTest(res.data as TestResult);
    } catch {
      setSuperopsTest({ ok: false, error: 'Request failed' });
    } finally {
      setSuperopsTesting(false);
    }
  };

  const handleSaveSuperops = async () => {
    if (!tenant) return;
    setSuperopsSave('saving');
    try {
      const body: Record<string, string> = { superopsSubdomain: subdomain.trim() };
      if (superopsKey.trim()) body.superopsApiKey = superopsKey.trim();
      await api.patch(`/tenants/${tenant.id}`, body);
      setSuperopsSave('saved');
      setTenant({ ...tenant, superopsSubdomain: subdomain.trim() });
      setSuperopsKey('');
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
    } catch {
      setAiTest({ ok: false, error: 'Request failed' });
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
        aiApiKey: aiApiKey.trim() || null,
      };
      await api.patch(`/tenants/${tenant.id}`, body);
      setAiSave('saved');
      setTenant({ ...tenant, aiBaseUrl: aiBaseUrl.trim() || null, aiModel: aiModel.trim() || null });
      setAiApiKey('');
      setTimeout(() => setAiSave('idle'), 2500);
    } catch {
      setAiSave('error');
      setTimeout(() => setAiSave('idle'), 3000);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-gray-400 text-sm">Loading...</div>
    );
  }

  if (!tenant) {
    return (
      <div className="p-8 text-red-500 text-sm">No tenant found.</div>
    );
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-xl font-bold text-gray-900 mb-1">Settings</h1>
      <p className="text-sm text-gray-500 mb-8">Update your SuperOps connection and AI provider configuration.</p>

      {/* SuperOps section */}
      <section className="mb-10">
        <h2 className="text-base font-semibold text-gray-800 mb-4">SuperOps Connection</h2>
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
            <p className="text-xs text-gray-400 mt-1">Just the subdomain — e.g. <code>mightyit</code> not <code>mightyit.superops.ai</code></p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key <span className="text-gray-400 font-normal">(leave blank to keep existing)</span></label>
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
              {superopsSave === 'saving' ? 'Saving…' : superopsSave === 'saved' ? 'Saved!' : superopsSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      <hr className="border-gray-200 mb-10" />

      {/* AI section */}
      <section className="mb-10">
        <h2 className="text-base font-semibold text-gray-800 mb-4">AI Provider</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
            <input
              type="url"
              value={aiBaseUrl}
              onChange={(e) => { setAiBaseUrl(e.target.value); setAiTest(null); }}
              placeholder="http://localhost:11434/v1"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
            />
            <p className="text-xs text-gray-400 mt-1">OpenAI-compatible endpoint — works with Ollama, LM Studio, Groq, OpenAI</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key <span className="text-gray-400 font-normal">(leave blank to keep existing or if not required)</span></label>
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
              {aiSave === 'saving' ? 'Saving…' : aiSave === 'saved' ? 'Saved!' : aiSave === 'error' ? 'Error — try again' : 'Save'}
            </button>
          </div>
        </div>
      </section>

      <hr className="border-gray-200 mb-8" />

      {/* Tenant info */}
      <section>
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
