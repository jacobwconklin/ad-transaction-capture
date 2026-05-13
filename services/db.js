import { Pool } from 'pg';
import { sendErrorEmail } from './email.js';

// Single pool shared across all requests — avoids opening a new connection per webhook call.
const dbUrl = new URL(process.env.DATABASE_URL);
dbUrl.searchParams.set('sslmode', 'no-verify');

const pool = new Pool({
  connectionString: dbUrl.toString(),
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
  sendErrorEmail(`DB pool error: ${err.message}`).catch(() => {});
});

/**
 * testConnection
 * Acquires one client from the pool, runs a trivial query, then releases it.
 * Used by the /health endpoint to verify Postgres is reachable.
 */
const testConnection = async () => {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
};

/**
 * createTable
 * Idempotent DDL — creates the transactions table if it doesn't exist yet.
 * Called once at startup so the schema is always in sync without a separate migration step.
 */
const createTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                     SERIAL PRIMARY KEY,
      authnet_transaction_id TEXT        NOT NULL,
      site_domain            TEXT        NOT NULL,
      gclid                  TEXT,
      amount                 NUMERIC     NOT NULL,
      currency               TEXT        NOT NULL,
      conversion_action_id   TEXT        NOT NULL,
      customer_id            TEXT        NOT NULL,
      status                 TEXT        NOT NULL DEFAULT 'captured',
      refund                 BOOLEAN     NOT NULL DEFAULT false,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}; // TODO 1 may remove this later, but should keep record of SQL

/**
 * createDomainsTable
 * Idempotent DDL — creates the domains table if it doesn't exist yet.
 * Each row represents a unique client site identified by its Google Ads
 * customer_id + conversion_action_id pair. Upserted on every GCLID mapping
 * POST so no manual server-side setup is needed when onboarding a new site.
 */
const createDomainsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS domains (
      id                   SERIAL PRIMARY KEY,
      currency             TEXT        NOT NULL,
      conversion_action_id TEXT        NOT NULL,
      customer_id          TEXT        NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (customer_id, conversion_action_id)
    )
  `);
};

/**
 * createGclidMappingsTable
 * Idempotent DDL — creates the refid_gclid_mapping table if it doesn't exist yet.
 * The serial PK doubles as the ref_id returned to the client and later set as
 * Authorize.net's invoiceNumber, guaranteeing collision-free IDs without any
 * client-side generation logic. domain_id links each mapping to its site config.
 */
const createGclidMappingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refid_gclid_mapping (
      refid      SERIAL  PRIMARY KEY,
      gclid      TEXT        NOT NULL,
      domain_id  INTEGER     NOT NULL REFERENCES domains(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

/**
 * insertTransaction
 * Persists a new payment event to the transactions table.
 * @param {object} data - Fields extracted from the Authorize.net payload + siteConfig.
 */
const insertTransaction = async (data) => {
  const {
    authnetTransactionId,
    siteDomain,
    gclid,
    amount,
    currency,
    conversionActionId,
    customerId,
    status,
    refund = false,
  } = data;

  try {
    await pool.query(
      `INSERT INTO transactions
         (authnet_transaction_id, site_domain, gclid, amount, currency,
          conversion_action_id, customer_id, status, refund)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        authnetTransactionId,
        siteDomain,
        gclid || null,
        amount,
        currency,
        conversionActionId,
        customerId,
        status || 'captured',
        refund,
      ]
    );
  } catch (err) {
    console.error('[db] insertTransaction failed:', err.message);
    await sendErrorEmail(`insertTransaction failed for domain=${siteDomain} txn=${authnetTransactionId}: ${err.message}`);
    throw err;
  }
};

/**
 * getTransactionByAuthnetId
 * Looks up a transaction by its Authorize.net transaction ID.
 * Used by the refund endpoint to retrieve gclid and Google Ads IDs.
 * @param {string} authnetTransactionId
 * @returns {object|null} Row or null if not found.
 */
const getTransactionByAuthnetId = async (authnetTransactionId) => {
  const result = await pool.query(
    'SELECT * FROM transactions WHERE authnet_transaction_id = $1 LIMIT 1',
    [authnetTransactionId]
  );
  return result.rows[0] || null;
};

/**
 * updateTransactionStatus
 * Sets the status column on an existing transaction row.
 * Called when a refund webhook is received to mark the row 'refunded'.
 * @param {string} authnetTransactionId
 * @param {string} status - New status value, e.g. 'refunded'.
 */
const updateTransactionStatus = async (authnetTransactionId, status) => {
  try {
    await pool.query(
      'UPDATE transactions SET status = $1, refund = $2 WHERE authnet_transaction_id = $3',
      [status, status === 'refunded', authnetTransactionId]
    );
  } catch (err) {
    console.error('[db] updateTransactionStatus failed:', err.message);
    await sendErrorEmail(`updateTransactionStatus failed for txn=${authnetTransactionId}: ${err.message}`);
    throw err;
  }
};

/**
 * upsertDomain
 * Inserts a domain config row if one doesn't already exist for this
 * (customer_id, conversion_action_id) pair, then returns the row's id.
 * Called on every GCLID mapping POST so new sites self-register without
 * any manual server-side setup.
 * @param {{ currency: string, conversionActionId: string, customerId: string }} data
 * @returns {number} The domain's id.
 */
const upsertDomain = async ({ currency, conversionActionId, customerId }) => {
  const result = await pool.query(
    `INSERT INTO domains (currency, conversion_action_id, customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (customer_id, conversion_action_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id`,
    [currency, conversionActionId, customerId]
  );
  return result.rows[0].id;
};

/**
 * insertGclidMapping
 * Inserts a new refid_gclid_mapping row and returns its serial refid, which the
 * /gclid-mapping endpoint sends back to the browser as ref_id.
 * @param {{ gclid: string, domainId: number }} data
 * @returns {number} The new row's refid.
 */
const insertGclidMapping = async ({ gclid, domainId }) => {
  const result = await pool.query(
    'INSERT INTO refid_gclid_mapping (gclid, domain_id) VALUES ($1, $2) RETURNING refid',
    [gclid, domainId]
  );
  return result.rows[0].refid;
};

/**
 * getMappingByRefId
 * Looks up the gclid and domain_id stored for a given ref_id (the serial PK).
 * Called by the webhook handler after reading merchantReferenceId off the
 * Authorize.net payload.
 * @param {number|string} refId
 * @returns {{ gclid: string, domainId: number }|null}
 */
const getMappingByRefId = async (refId) => {
  const result = await pool.query(
    'SELECT gclid, domain_id FROM refid_gclid_mapping WHERE refid = $1',
    [parseInt(refId, 10)]
  );
  if (!result.rows[0]) return null;
  return { gclid: result.rows[0].gclid, domainId: result.rows[0].domain_id };
};

/**
 * getDomainById
 * Retrieves a domain's site config by its id.
 * Called by the webhook handler after resolving domain_id from the mapping table.
 * @param {number} domainId
 * @returns {{ currency: string, conversionActionId: string, customerId: string }|null}
 */
const getDomainById = async (domainId) => {
  const result = await pool.query(
    'SELECT currency, conversion_action_id, customer_id FROM domains WHERE id = $1',
    [domainId]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    currency: row.currency,
    conversionActionId: row.conversion_action_id,
    customerId: row.customer_id,
  };
};

export {
  testConnection,
  createTable,
  createDomainsTable,
  createGclidMappingsTable,
  insertTransaction,
  upsertDomain,
  insertGclidMapping,
  getMappingByRefId,
  getDomainById,
  getTransactionByAuthnetId,
  updateTransactionStatus,
};
