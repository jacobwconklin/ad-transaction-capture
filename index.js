import 'dotenv/config';

import express from 'express';
import webhookRouter from './routes/webhook.js';
import gclidMappingRouter from './routes/gclidMapping.js';
import { testConnection, createTable, createGclidMappingsTable } from './services/db.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse raw body as Buffer so verifySignature can compute HMAC over the exact bytes Authorize.net sent.
// Must come before express.json() so the raw body is preserved.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Mount webhook routes under /webhook
app.use('/webhook', webhookRouter);
app.use('/gclid-mapping', gclidMappingRouter);

/**
 * GET /health
 * Lightweight liveness + DB-connectivity check.
 * Returns 200 if the server is running and the database pool can reach Postgres,
 * 500 with a JSON error if the DB connection fails.
 */
app.get('/health', async (req, res) => {
  try {
    await testConnection();
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[health] DB check failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** // TODO overkill / unnecessary want to take out once working.
 * Bootstrap — ensure DB schema exists before accepting traffic.
 * createTable is idempotent so it is safe to run on every startup.
 */
const start = async () => {
  try {
    await createTable();
    await createGclidMappingsTable();
    console.log('[server] DB schema ready');
  } catch (err) {
    console.error('[server] Failed to initialize DB schema:', err.message);
    // Still start the server — health check will surface the DB error.
  }

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
  });
};

start();
