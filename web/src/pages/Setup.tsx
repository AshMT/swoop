import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  setupAdmin,
  testSuperOps,
  setupTenant,
  testAi,
  setupAiConfig,
  setupClient,
} from '../api';

interface Props {
  onComplete: () => void;
}

type Step = 'admin' | 'superops' | 'ai' | 'client' | 'done';

export default function Setup({ onComplete }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('admin');
  const [tenantId, setTenantId] = useState('');

  // Step state
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [mspName, setMspName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [superopsKey, setSuperopsKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('http://localhost:11434/v1');
  const [aiKey, setAiKey] = useState('ollama');
  const [aiModel, setAiModel] = useState('qwen3:8b');
  const [clientName, setClientName] = useState('');
  const [clientCompanyId, setClientCompanyId] = useState('');
  const [clientEnabled, setClientEnabled] = useState(false);

  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [error, setError] = useState('');

  const STEPS = [
    { key: 'admin', label: 'Admin account' },
    { key: 'superops', label: 'SuperOps connection' },
    { key: 'ai', label: 'AI provider' },
    { key: 'client', label: 'First client' },
  ];

  const currentIndex = STEPS.findIndex((s) => s.key === step);

  const handleAdmin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await setupAdmin(adminEmail, adminPassword);
      localStorage.setItem('swoop_token', res.data.token);
      setStep('superops');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  const handleTestSuperOps = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testSuperOps(subdomain, superopsKey);
      setTestResult(res.data.ok);
    } catch {
      setTestResult(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSuperOps = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await setupTenant(mspName, subdomain, superopsKey);
      setTenantId(res.data.id);
      setStep('ai');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save SuperOps config');
    } finally {
      setLoading(false);
    }
  };

  const handleTestAi = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testAi(aiBaseUrl, aiKey, aiModel);
      setTestResult(res.data.ok);
    } catch {
      setTestResult(false);
    } finally {
      setTesting(false);
    }
  };

  const handleAi = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await setupAiConfig(tenantId, aiBaseUrl, aiKey, aiModel);
      setStep('client');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save AI config');
    } finally {
      setLoading(false);
    }
  };

  const handleClient = async (e: FormEvent) => {
    e.preventDefault();
    if (!clientName.trim()) {
      setStep('done');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await setupClient(tenantId, clientName, clientCompanyId || undefined, clientEnabled);
      setStep('done');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to add client');
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = () => {
    onComplete();
    navigate('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Welcome to Swoop</h1>
          <p className="text-gray-500 mt-1">Let's get you set up in a few minutes</p>
        </div>

        {/* Stepper */}
        {step !== 'done' && (
          <div className="flex items-center justify-center mb-8">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex items-center">
                <div className={`flex items-center gap-2 ${i <= currentIndex ? 'text-swoop-600' : 'text-gray-400'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                    i < currentIndex ? 'bg-swoop-600 border-swoop-600 text-white' :
                    i === currentIndex ? 'border-swoop-600 text-swoop-600' :
                    'border-gray-300 text-gray-400'
                  }`}>
                    {i < currentIndex ? '✓' : i + 1}
                  </div>
                  <span className="text-xs font-medium hidden sm:block">{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-8 h-0.5 mx-2 ${i < currentIndex ? 'bg-swoop-600' : 'bg-gray-300'}`} />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
          {error && (
            <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 text-sm mb-4">
              {error}
            </div>
          )}

          {/* Step 1: Admin */}
          {step === 'admin' && (
            <form onSubmit={handleAdmin} className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Create your admin account</h2>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="you@msp.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Min. 8 characters"
                />
              </div>
              <button type="submit" disabled={loading} className="w-full bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-lg text-sm">
                {loading ? 'Creating account...' : 'Continue'}
              </button>
            </form>
          )}

          {/* Step 2: SuperOps */}
          {step === 'superops' && (
            <form onSubmit={handleSuperOps} className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Connect SuperOps</h2>
              <p className="text-sm text-gray-500">Your API token is in SuperOps → Settings → My Profile → API Token</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">MSP name</label>
                <input
                  type="text"
                  value={mspName}
                  onChange={(e) => setMspName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="MightyIT"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">SuperOps subdomain</label>
                <div className="flex rounded-lg border border-gray-300 overflow-hidden focus-within:ring-2 focus-within:ring-swoop-500">
                  <span className="bg-gray-50 px-3 py-2 text-sm text-gray-500 border-r border-gray-300">https://</span>
                  <input
                    type="text"
                    value={subdomain}
                    onChange={(e) => setSubdomain(e.target.value)}
                    required
                    className="flex-1 px-3 py-2 text-sm focus:outline-none"
                    placeholder="yourcompany"
                  />
                  <span className="bg-gray-50 px-3 py-2 text-sm text-gray-500 border-l border-gray-300">.superops.ai</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API token</label>
                <input
                  type="password"
                  value={superopsKey}
                  onChange={(e) => setSuperopsKey(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Your SuperOps API token"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => { setTestResult(null); handleTestSuperOps(); }}
                  disabled={testing || !subdomain || !superopsKey}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  {testing ? 'Testing...' : 'Test connection'}
                </button>
                {testResult === true && <span className="text-green-600 text-sm font-medium">Connected!</span>}
                {testResult === false && <span className="text-red-600 text-sm">Connection failed — check credentials</span>}
              </div>
              <button type="submit" disabled={loading} className="w-full bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-lg text-sm">
                {loading ? 'Saving...' : 'Continue'}
              </button>
            </form>
          )}

          {/* Step 3: AI */}
          {step === 'ai' && (
            <form onSubmit={handleAi} className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Configure AI provider</h2>
              <p className="text-sm text-gray-500">Works with any OpenAI-compatible API: Ollama, OpenAI, Groq, etc.</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                <input
                  type="url"
                  value={aiBaseUrl}
                  onChange={(e) => setAiBaseUrl(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="http://localhost:11434/v1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">API key</label>
                <input
                  type="password"
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="ollama (or your API key)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                <input
                  type="text"
                  value={aiModel}
                  onChange={(e) => setAiModel(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="qwen3:8b"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => { setTestResult(null); handleTestAi(); }}
                  disabled={testing || !aiBaseUrl || !aiModel}
                  className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  {testing ? 'Testing...' : 'Test connection'}
                </button>
                {testResult === true && <span className="text-green-600 text-sm font-medium">AI is responding!</span>}
                {testResult === false && <span className="text-red-600 text-sm">AI not responding — check config</span>}
              </div>
              <button type="submit" disabled={loading} className="w-full bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-lg text-sm">
                {loading ? 'Saving...' : 'Continue'}
              </button>
            </form>
          )}

          {/* Step 4: Client */}
          {step === 'client' && (
            <form onSubmit={handleClient} className="space-y-4">
              <h2 className="text-lg font-semibold text-gray-900">Add your first client</h2>
              <p className="text-sm text-gray-500">Add a client to start monitoring their tickets. You can skip this and add clients later.</p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Client name</label>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Acme Corp"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">SuperOps Company ID <span className="text-gray-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={clientCompanyId}
                  onChange={(e) => setClientCompanyId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-swoop-500"
                  placeholder="Company ID from SuperOps"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={clientEnabled}
                  onChange={(e) => setClientEnabled(e.target.checked)}
                  className="w-4 h-4 rounded text-swoop-600"
                />
                <span className="text-sm text-gray-700">Enable automation for this client (start classifying tickets immediately)</span>
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setStep('done')}
                  className="flex-1 px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
                >
                  Skip for now
                </button>
                <button type="submit" disabled={loading} className="flex-1 bg-swoop-600 hover:bg-swoop-700 disabled:opacity-60 text-white font-medium py-2 px-4 rounded-lg text-sm">
                  {loading ? 'Adding...' : 'Add client'}
                </button>
              </div>
            </form>
          )}

          {/* Done */}
          {step === 'done' && (
            <div className="text-center space-y-4">
              <div className="text-5xl">🎉</div>
              <h2 className="text-xl font-semibold text-gray-900">Swoop is ready!</h2>
              <p className="text-gray-500 text-sm">Swoop will now poll SuperOps every 60 seconds, classify tickets, and post internal notes with its proposals. No actions will be taken.</p>
              <button
                onClick={handleFinish}
                className="w-full bg-swoop-600 hover:bg-swoop-700 text-white font-medium py-2 px-4 rounded-lg text-sm"
              >
                Go to dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
