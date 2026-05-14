import 'dotenv/config';

import express from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger.js';
import webhookRouter from './routes/webhook.js';
import gclidMappingRouter from './routes/gclidMapping.js';
import { testConnection, createTransactionsTable, createDomainsTable, createGclidMappingsTable } from './services/db.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mount webhook routes under /webhook
app.use('/webhook', webhookRouter);
app.use('/gclid-mapping', gclidMappingRouter);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @openapi
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           example: Something went wrong
 *
 * /health:
 *   get:
 *     summary: Liveness and database connectivity check
 *     description: Returns 200 if the server is running and the DB pool can reach Postgres.
 *     responses:
 *       200:
 *         description: Server and database are healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *       500:
 *         description: Database connection failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: error
 *                 message:
 *                   type: string
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

/**
 * Bootstrap — ensure DB schema exists before accepting traffic.
 * createTransactionsTable is idempotent so it is safe to run on every startup.
 */
const start = async () => {
  try {
    await createDomainsTable();
    await createGclidMappingsTable(); // depends on domains
    await createTransactionsTable();  // depends on refid_gclid_mapping
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
