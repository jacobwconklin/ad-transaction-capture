# Google Ads Webhook API — Plan

## Overview
Express REST API that receives Authorize.net payment webhooks, persists transactions to PostgreSQL, and reports conversions to Google Ads via GCLID. A single hosted instance serves multiple WordPress sites — each site passes its own per-domain config (currency, conversion action ID, customer ID) with every request.

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
- [ ] Create `transactions` table:
  - `id` (serial PK), `authnet_transaction_id`, `site_domain`, `gclid`, `amount`, `currency`, `conversion_action_id`, `customer_id`, `status`, `raw_payload` (jsonb), `created_at`
- [ ] Write `insertTransaction(data)` query function using `pool.query()`
- [ ] Write `updateTransactionStatus(authnetTransactionId, status)` query function (used by refund endpoint) using `pool.query()`
- [ ] On failure to connect or insert into the database, send an error email with the error

### 3. Per-Domain Config — Request Schema
Each webhook `POST` body must include a `siteConfig` object alongside the Authorize.net payload:
```json
{
  "authorizeNetPayload": { ... },
  "siteConfig": {
    "domain": "client-site.com",
    "currency": "USD",
    "conversionActionId": "123456789",
    "customerId": "111-222-3333"
  }
}
```
- [ ] Validate that `siteConfig` fields are present; reject with `400` if missing
- [ ] Use `siteConfig` values for all downstream DB writes and Google Ads calls
- [ ] No per-site secrets stored server-side — shared Google Ads developer token and OAuth credentials cover all customer accounts under the same MCC (manager account)

### 4. Webhook Endpoint — `POST /webhook/authorizenet`
- [ ] Verify Authorize.net `X-ANET-Signature` header (HMAC-SHA512 of raw body vs. signature key)
- [ ] Parse payload, extract: `transactionId`, `amount`, `responseCode`, and custom field `gclid`
- [ ] Validate `siteConfig` fields present
- [ ] Insert record into `transactions` table (including `site_domain`, `currency`, `conversion_action_id`, `customer_id`)
- [ ] On failure to insert into the database, send an error email with the error
- [ ] If payment successful (`responseCode === 1`), call Google Ads service with `siteConfig`
- [ ] Return `200 OK` immediately regardless of Google Ads outcome

### 4b. Refund Webhook Endpoint — `POST /webhook/authorizenet/refund`
- [ ] Apply same `verifySignature` middleware — identical HMAC-SHA512 check
- [ ] Parse payload, extract: `transactionId`, `refundAmount`, and `siteConfig` (same schema as payment endpoint)
- [ ] Look up the original transaction in DB by `authnet_transaction_id` to retrieve the stored `gclid`, `conversionActionId`, and `customerId`
- [ ] Update the transaction row: set `status = 'refunded'`
- [ ] On failure to update the database, send an error email with the error
- [ ] If original transaction found and has a `gclid`, call Google Ads refund service with `siteConfig`
- [ ] If original transaction not found, log a warning and return `200 OK` (don't error — Authorize.net will retry)
- [ ] Event to handle: `net.authorize.payment.refund.created`

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
```
Per-site values (`customerId`, `conversionActionId`, `currency`) come from the request body — nothing per-site in `.env`.

---

## Authorize.net Notes
- Webhooks send a `POST` with JSON body and `X-ANET-Signature` header
- The `gclid` must be stored as a custom field on the Authorize.net transaction (populated from WordPress hidden field at checkout)
- Events to handle: `net.authorize.payment.authcapture.created`, `net.authorize.payment.refund.created`

## Google Ads Notes
- All sites must be sub-accounts under a single MCC (manager account) so one refresh token covers all
- Conversions are uploaded after the fact using the stored `gclid`
- `conversion_date_time` format: `"2026-05-05 14:30:00+00:00"`
- Each site's Conversion Action must already exist in its respective Google Ads account

## Multi-Site Notes
- One running server instance handles all 5 sites
- Sites are distinguished by `siteConfig.domain` in logs and DB rows
- No routing changes needed per site — the endpoint is identical for all callers
