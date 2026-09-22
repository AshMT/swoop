import express from 'express';
import path from 'path';
import fs from 'fs';
import { ConfigError, config, loadConfig } from './config';
import { createLogger } from './lib/logger';
import { closeDatabase, initializeDatabase } from './db';
import { errorHandler, requestLogger, securityHeaders } from './middleware/security';
import authRoutes from './routes/auth';
import setupRoutes from './routes/setup';
import tenantsRoutes from './routes/api/tenants';
import clientsRoutes from './routes/api/clients';
import actionsRoutes from './routes/api/actions';
import systemRoutes from './routes/api/system';
import { startPoller, stopPoller } from './services/poller';
import { APP_VERSION } from './version';

const log = createLogger('Server');

export function createApp(): express.Express {
  const cfg = config();
  const app = express();

  app.disable('x-powered-by');
  // Only honour X-Forwarded-For when an operator has said there is a proxy in
  // front; otherwise the header is client-controlled and would defeat the rate
  // limiter.
  if (cfg.trustProxy) app.set('trust proxy', true);

  app.use(securityHeaders);
  app.use(requestLogger);
  // A ticket body can be long, but nothing legitimate posts a megabyte here.
  app.use(express.json({ limit: '256kb' }));

  // No CORS middleware: the SPA is served from this same origin, so allowing
  // cross-origin requests would only widen the attack surface. Set
  // CORS_ORIGIN to opt in to a specific origin during frontend development.
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  if (corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: APP_VERSION });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/tenants', tenantsRoutes);
  app.use('/api/clients', clientsRoutes);
  app.use('/api/actions', actionsRoutes);
  app.use('/api/system', systemRoutes);

  // An unknown API path must be a JSON 404. The previous catch-all served
  // index.html for these, so a typo'd endpoint returned 200 and a page of HTML
  // that the client then tried to parse as JSON.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API endpoint' });
  });

  // ─── SPA ────────────────────────────────────────────────────────────────────
  const webDistPath = path.join(__dirname, '..', 'web', 'dist');
  const indexPath = path.join(webDistPath, 'index.html');
  const hasBuiltUi = fs.existsSync(indexPath);

  if (hasBuiltUi) {
    app.use(
      express.static(webDistPath, {
        // Vite fingerprints asset filenames, so they are safe to cache hard.
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (_req, res) => res.sendFile(indexPath));
  } else {
    log.warn(`No built UI found at ${webDistPath} — run "npm run build" (API routes still work).`);
    app.get('*', (_req, res) => {
      res.status(503).type('text/plain').send('The Swoop UI has not been built. Run: npm run build');
    });
  }

  app.use(errorHandler);
  return app;
}

export function startServer(): void {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = config();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Exit loudly rather than booting with placeholder secrets.
      console.error('\nSwoop cannot start — the configuration is not valid:\n');
      for (const problem of err.problems) console.error(`  • ${problem}`);
      console.error('\nSee .env.example for the full list of settings.\n');
      process.exit(1);
    }
    throw err;
  }

  try {
    initializeDatabase();
  } catch (err) {
    log.error('Could not initialise the database', err);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(cfg.port, () => {
    log.info(`Swoop ${APP_VERSION} listening on http://localhost:${cfg.port} (${cfg.nodeEnv})`);
    if (!cfg.encryptionEnabled) {
      log.warn('ENCRYPTION_KEY is not set — stored credentials will not be encrypted at rest.');
    }
    startPoller();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${cfg.port} is already in use. Set PORT to a free port.`);
      process.exit(1);
    }
    log.error('HTTP server error', err);
    process.exit(1);
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down`);

    // Hard deadline so a wedged request cannot block the container forever.
    const forceExit = setTimeout(() => {
      log.warn('Shutdown timed out, exiting now');
      process.exit(1);
    }, 30_000);
    forceExit.unref();

    server.close(() => log.debug('HTTP server closed'));
    // Let the in-flight poll cycle finish so no ticket is left claimed but
    // unclassified.
    await stopPoller();
    closeDatabase();
    clearTimeout(forceExit);
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception — exiting so the container restarts', err);
    void shutdown('uncaughtException');
  });
}

// Only auto-start when run as the entry point, so tests can import createApp.
if (require.main === module) {
  startServer();
}
