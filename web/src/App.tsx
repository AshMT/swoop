import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { getSetupStatus, getToken } from './api';
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { LoadingState, ToastProvider } from './components/ui';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Calibration from './pages/Calibration';
import Clients from './pages/Clients';
import Settings from './pages/Settings';

export default function App() {
  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);
  const [reachable, setReachable] = useState(true);

  // Apply the stored theme before the first paint of any page.
  useEffect(() => {
    applyTheme(readTheme());
    if (readTheme() !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, []);

  useEffect(() => {
    getSetupStatus()
      .then((res) => {
        setSetupComplete(res.data.setupComplete);
        setReachable(true);
      })
      .catch(() => {
        // Distinguish "not set up" from "server unreachable": routing someone
        // to the setup wizard because the API is down would be actively wrong.
        setReachable(false);
      })
      .finally(() => setLoading(false));
  }, []);

  // Read once per mount. A sign-in navigates the whole page, so this is never
  // stale in practice, and a 401 interceptor clears it and redirects.
  const token = getToken();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <LoadingState label="Starting Swoop" />
      </div>
    );
  }

  if (!reachable) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
        <div className="card max-w-md p-6 text-center">
          <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Cannot reach the Swoop server
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            The UI loaded, but the API did not respond. Check that the container is running and look at its
            logs — a configuration problem makes Swoop exit on purpose rather than start up insecurely.
          </p>
          <button onClick={() => window.location.reload()} className="btn-primary mt-4">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const guard = (element: React.ReactNode) => {
    if (!setupComplete) return <Navigate to="/setup" replace />;
    if (!token) return <Navigate to="/login" replace />;
    return element;
  };

  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
        <Routes>
          <Route
            path="/setup"
            element={
              setupComplete ? (
                <Navigate to="/dashboard" replace />
              ) : (
                <Setup onComplete={() => setSetupComplete(true)} />
              )
            }
          />
          <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <Login />} />
          <Route path="/" element={guard(<Navigate to="/dashboard" replace />)} />
          <Route element={guard(<Layout />)}>
            {/* Boundaries sit inside the layout so a failing page keeps the
                navigation, the health banner and the theme toggle usable. */}
            <Route
              path="/dashboard"
              element={
                <ErrorBoundary label="The dashboard">
                  <Dashboard />
                </ErrorBoundary>
              }
            />
            <Route
              path="/calibration"
              element={
                <ErrorBoundary label="The calibration report">
                  <Calibration />
                </ErrorBoundary>
              }
            />
            <Route
              path="/clients"
              element={
                <ErrorBoundary label="The client list">
                  <Clients />
                </ErrorBoundary>
              }
            />
            <Route
              path="/settings"
              element={
                <ErrorBoundary label="Settings">
                  <Settings />
                </ErrorBoundary>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
