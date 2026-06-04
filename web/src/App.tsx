import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Setup from './pages/Setup';
import Dashboard from './pages/Dashboard';
import Clients from './pages/Clients';
import Layout from './components/Layout';
import { getSetupStatus } from './api';

function App() {
  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);
  const token = localStorage.getItem('swoop_token');

  useEffect(() => {
    getSetupStatus()
      .then((res) => setSetupComplete(res.data.setupComplete))
      .catch(() => setSetupComplete(false))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/setup"
          element={setupComplete ? <Navigate to="/dashboard" replace /> : <Setup onComplete={() => setSetupComplete(true)} />}
        />
        <Route
          path="/login"
          element={token ? <Navigate to="/dashboard" replace /> : <Login />}
        />
        <Route
          path="/"
          element={
            !setupComplete ? <Navigate to="/setup" replace /> :
            !token ? <Navigate to="/login" replace /> :
            <Navigate to="/dashboard" replace />
          }
        />
        <Route
          element={
            !setupComplete ? <Navigate to="/setup" replace /> :
            !token ? <Navigate to="/login" replace /> :
            <Layout />
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/clients" element={<Clients />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
