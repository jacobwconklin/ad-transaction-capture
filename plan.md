# Google Ads Webhook API — Plan

## Overview
Express REST API that receives Authorize.net payment webhooks, persists transactions to PostgreSQL, and reports conversions to Google Ads via GCLID. A single hosted instance serves multiple WordPress sites — each site's per-domain config (currency, conversion action ID, customer ID) is stored server-side in a `domains` table, populated when the PHP snippet posts the GCLID mapping on form submission. No per-site config is passed with webhook events.

---

## Stack
- **Runtime:** Node.js + Express
- **Database:** PostgreSQL (via `pg` or `postgres` npm package)
- **Google Ads:** `google-ads-api` npm package
- **Auth:** Authorize.net webhook signature verification (HMAC-SHA512)

---

## Project Structure
```
/
├── index.js              # Entry point, Express setup
├── routes/
│   └── webhook.js        # POST /webhook/authorizenet, POST /webhook/authorizenet/refund
├── services/
│   ├── db.js             # PostgreSQL connection + queries
│   ├── email.js          # Error notification emails via SMTP
│   └── googleAds.js      # Google Ads conversion upload + retry logic
├── middleware/
│   └── verifySignature.js # Authorize.net HMAC verification
├── .env                  # Secrets (never commit)
└── plan.md
```

---

## Tasks

### 0. WordPress — GCLID Capture (Jacob's work)
- [ ] Write a small JavaScript snippet to run on all pages of each WordPress site
- [ ] On page load, read `gclid` from the URL query parameter (`?gclid=...`)
- [ ] If present, persist it to both `localStorage` and a cookie with a 90-day expiry
- [ ] On subsequent pages (no `gclid` in URL), read the value from `localStorage` or cookie as fallback
- [ ] On WPForms submission, populate a hidden field (e.g. `hidden_gclid`) with the stored value
- [ ] Verify the hidden field value is passed through to Authorize.net as a custom field at checkout

### 1. Project Setup
- [ ] `npm init`, install deps: `express`, `pg`, `google-ads-api`, `dotenv`, `crypto` (built-in)
- [ ] Create `.env` with DB credentials, Authorize.net signature key, Google Ads shared credentials

### 2. Database
- [ ] Connect to PostgreSQL using `pg`
- [ ] Use `pg.Pool` to create a connection pool at application startup for efficient connection reuse across requests (avoid opening a new connection per request)
- [ ] Create `domains` table:
  - `id` (serial PK), `currency`, `conversion_action_id`, `customer_id`, `created_at`
  - Unique constraint on `(customer_id, conversion_action_id)` to prevent duplicates
- [ ] Create `refid_gclid_mapping` table:
  - `refid` (serial PK), `gclid`, `domain_id` (FK → `domains.id`), `created_at`
- [ ] Create `transactions` table:
  - `id` (serial PK), `authnet_transaction_id`, `site_domain`, `gclid`, `amount`, `currency`, `conversion_action_id`, `customer_id`, `status`, `refund` (boolean, default false), `created_at`
- [ ] Write `upsertDomain({ currency, conversionActionId, customerId })` — inserts or returns existing domain row
- [ ] Write `insertGclidMapping({ gclid, domainId })` — returns new `refid`
- [ ] Write `getGclidAndDomainByRefId(refId)` — returns `{ gclid, domain_id }` from mapping table
- [ ] Write `getDomainById(domainId)` — returns `{ currency, conversion_action_id, customer_id }` from domains table
- [ ] Write `insertTransaction(data)` query function using `pool.query()`
- [ ] Write `updateTransactionStatus(authnetTransactionId, status)` query function (used by refund endpoint) using `pool.query()`
- [ ] On failure to connect or insert into the database, send an error email with the error

### 3. Per-Domain Config — Server-Side Storage
Per-site config (currency, conversion action ID, customer ID) is stored in the `domains` table, not passed with webhook events. Config is written once when the PHP snippet first posts a GCLID mapping for a site.

- [ ] On `POST /gclid-mapping`, accept `{ gclid, currency, conversion_action_id, customer_id }` in the request body
- [ ] Upsert into `domains` based on `(customer_id, conversion_action_id)` — insert if new, return existing `id` if already present
- [ ] Insert into `refid_gclid_mapping` with the returned `domain_id` as a foreign key
- [ ] No per-site config is stored server-side in `.env` — shared Google Ads developer token and OAuth credentials cover all customer accounts under the same MCC (manager account)
- [ ] On `POST /webhook/authorizenet`, read `merchantReferenceId` from the Authorize.net payload, look up `gclid` and `domain_id` from `refid_gclid_mapping`, then look up site config from `domains` by `domain_id`

### 4. Webhook Endpoint — `POST /webhook/authorizenet`
- [ ] Verify Authorize.net `X-ANET-Signature` header (HMAC-SHA512 of raw body vs. signature key)
- [ ] Parse payload, extract: `eventType`, `merchantReferenceId`, `transactionId`, `amount`, `responseCode`
- [ ] If `merchantReferenceId` is absent, log that the transaction did not originate from a Google Ad and return early
- [ ] Look up `gclid` and `domain_id` from `refid_gclid_mapping` by `merchantReferenceId`
- [ ] Look up site config (`currency`, `conversion_action_id`, `customer_id`) from `domains` by `domain_id`
- [ ] Insert record into `transactions` table
- [ ] On failure to insert into the database, send an error email with the error
- [ ] If payment successful (`responseCode === 1`), call Google Ads service with resolved site config
- [ ] Return `200 OK` immediately regardless of Google Ads outcome

### 4b. Refund Webhook — handled in same endpoint
- [ ] On `net.authorize.payment.refund.created`, apply same `merchantReferenceId` → `gclid` + `domain_id` lookup
- [ ] Look up the original transaction in DB by `authnet_transaction_id` to retrieve its `created_at` for the adjustment timestamp
- [ ] Update the transaction row: set `status = 'refunded'` and `refund = true`
- [ ] On failure to update the database, send an error email with the error
- [ ] Call Google Ads refund adjustment service with resolved site config
- [ ] If original transaction not found, log a warning and return (don't error — Authorize.net will retry)

### 5. Google Ads Conversion Upload — with Exponential Backoff
- [ ] Authenticate with Google Ads API using shared OAuth2 refresh token (covers all MCC sub-accounts)
- [ ] Build `ClickConversion` object: `gclid`, `conversion_date_time`, `conversion_value`, `currency_code`, `conversion_action` (from `siteConfig.conversionActionId`), `customer_id` (from `siteConfig.customerId`)
- [ ] Upload conversions via `ConversionUploadService.uploadClickConversions()`
- [ ] Upload refund adjustments via `ConversionAdjustmentUploadService.uploadConversionAdjustments()` with type `RESTATEMENT` and `adjusted_value: 0`
- [ ] Both upload paths share the same retry wrapper
- [ ] **Retry logic — 3 attempts with exponential backoff:**
  - Attempt 1: immediate
  - Attempt 2: wait 2s
  - Attempt 3: wait 4s
  - After 3 failures: send an error email with the error, do not throw
- [ ] Log success/failure per attempt (don't fail the webhook response if all retries exhausted)

### 6. Health Check Endpoint
- [ ] Add a basic health check endpoint `GET /health` that checks database connection and returns `200 OK` if healthy, `500` if not

### 6. Error Handling & Reliability
- [ ] Always return `200 OK` to Authorize.net to prevent duplicate webhook retries
- [ ] Wrap Google Ads call in try/catch — log errors with `site_domain` and `transactionId`, don't bubble up
- [ ] Log all incoming webhooks (domain, payload, timestamp) before any processing

### 7. Environment Variables
```
PORT
DATABASE_URL
AUTHNET_SIGNATURE_KEY
GOOGLE_ADS_DEVELOPER_TOKEN     # Shared across all sites
GOOGLE_ADS_CLIENT_ID           # Shared OAuth app
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN       # MCC-level refresh token
SMTP_HOST                      # SMTP server hostname
SMTP_PORT                      # SMTP port (587 for TLS, 465 for SSL)
SMTP_USER                      # SMTP login / sender address
SMTP_PASS                      # SMTP password
ERROR_EMAIL_TO                 # Recipient for error notifications
SUBMIT_TO_GOOGLE_ADS          # Set to 'true' to actually submit to Google Ads; omit or set to anything else to dry-run
```
Per-site values (`customerId`, `conversionActionId`, `currency`) come from the request body — nothing per-site in `.env`.

---

# Modernization Goals

1. Use `const` and `let` instead of `var` everywhere.
2. Use ES modules and `import`/`export` rather than `require`/`module.exports`.
3. Use arrow functions rather than the `function` keyword.

---

## Authorize.net Notes
- Webhooks send a `POST` with JSON body and `X-ANET-Signature` header
- See `captureGclidPlan.md` for details on identifying gclid after receiving webhook
- Events to handle: `net.authorize.payment.authcapture.created`, `net.authorize.payment.refund.created`

## Google Ads Notes
- All sites must be sub-accounts under a single MCC (manager account) so one refresh token covers all
- Conversions are uploaded after the fact using the stored `gclid`
- `conversion_date_time` format: `"2026-05-05 14:30:00+00:00"`
- Each site's Conversion Action must already exist in its respective Google Ads account

## Multi-Site Notes
- One running server instance handles all sites
- Per-site config (currency, conversion action ID, customer ID) is stored in the `domains` table, written on first GCLID mapping POST from each site
- Sites are distinguished by `domain_id` (FK from `refid_gclid_mapping` → `domains`) in DB rows
- No routing changes needed per site — the endpoint is identical for all callers
- No cross-site data contamination: each mapping row carries its own `domain_id`, so a webhook event always resolves to the correct site's config
