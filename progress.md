# Progress

## Done
- Initialized npm project and installed deps: `express`, `pg`, `google-ads-api`, `dotenv`
- Created folder structure: `routes/`, `services/`, `middleware/`
- `index.js` — Express server with raw-body preservation, startup DB schema init, graceful error handling
- `GET /health` — liveness + DB connectivity check (200 ok / 500 error)
- `services/db.js` — `pg.Pool`, `createTable` (idempotent DDL), `insertTransaction`, `getTransactionByAuthnetId`, `updateTransactionStatus`; error email alerts on DB errors
- `services/email.js` — `sendErrorEmail` helper using nodemailer over SMTP
- `services/googleAds.js` — `uploadConversion` and `uploadRefundAdjustment` with 3-attempt exponential backoff (0s / 2s / 4s); error email alert on final failure
- `middleware/verifySignature.js` — HMAC-SHA512 validation of `X-ANET-Signature` header
- `routes/webhook.js` — `POST /webhook/authorizenet` (payment capture) and `POST /webhook/authorizenet/refund`; siteConfig validation; 200 returned before async processing
- `.env.example` with all required environment variables documented

## Remaining
- Task 0: WordPress GCLID capture snippet (Jacob's work — out of scope for this server)
- Provision a real PostgreSQL database and populate `.env`
- Set up Google Ads OAuth: obtain MCC-level refresh token, fill Google Ads env vars
- Set up Authorize.net webhook endpoint pointing to this server's public URL
- Configure SMTP env vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ERROR_EMAIL_TO`) for error alerts
- Deploy to hosting (e.g. Railway, Render, EC2)
