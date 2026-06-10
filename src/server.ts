import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initializeDatabase } from './db';
import authRoutes from './routes/auth';
import setupRoutes from './routes/setup';
import tenantsRoutes from './routes/api/tenants';
import clientsRoutes from './routes/api/clients';
import actionsRoutes from './routes/api/actions';
import policiesRoutes from './routes/api/policies';
import { startPoller } from './services/poller';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/tenants', tenantsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/actions', actionsRoutes);
app.use('/api/policies', policiesRoutes);

// ─── Serve React SPA ──────────────────────────────────────────────────────────
const webDistPath = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(webDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDistPath, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
try {
  initializeDatabase();
  console.log('[DB] Database initialized');
} catch (err) {
  console.error('[DB] Failed to initialize database:', err);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`[Server] Swoop listening on http://localhost:${PORT}`);
  startPoller();
});

export default app;
