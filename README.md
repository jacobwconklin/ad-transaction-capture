# Google Ads Webhook API

Express REST API that receives Authorize.net payment webhooks, stores transactions in PostgreSQL, and reports offline conversions to Google Ads via GCLID.

For installing the WordPress JavaScript and PHP snippets on client sites, see [wordpress/WordPressOnboarding.md](wordpress/WordPressOnboarding.md).

---

## 1. Configure Environment Variables

Copy `.env.example` to `.env` and fill in each value:

```bash
cp .env.example .env
```

| Variable | How to obtain |
|---|---|
| `PORT` | Leave as `3000` unless there's a conflict |
| `DATABASE_URL` | PostgreSQL connection string — `postgres://user:password@host:5432/dbname` |
| `AUTHNET_SIGNATURE_KEY` | Authorize.net dashboard → Account → Webhooks → your webhook → **Signature Key** |
| `AUTHNET_LOGIN_ID` | Authorize.net dashboard → Account → API Credentials & Keys → **API Login ID** |
| `AUTHNET_TRANSACTION_KEY` | Authorize.net dashboard → Account → API Credentials & Keys → **Transaction Key** |
| `SUBMIT_TO_GOOGLE_ADS` | Set to `true` to actually upload conversions; any other value (or omit) to dry-run |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads MCC → Tools → API Center → **Developer Token** |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 client → **Client ID** |
| `GOOGLE_ADS_CLIENT_SECRET` | Same OAuth 2.0 client → **Client Secret** |
| `GOOGLE_ADS_REFRESH_TOKEN` | Run the OAuth flow authenticated as the MCC account; capture the refresh token |
| `SMTP_HOST` | Your SMTP provider's hostname (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | `587` for STARTTLS, `465` for SSL |
| `SMTP_USER` | SMTP login / sender email address |
| `SMTP_PASS` | SMTP password or app-specific password |
| `ERROR_EMAIL_TO` | Email address to receive error alerts |
| `GCLID_MAPPING_API_KEY` | Choose any strong secret string — this is the Bearer token the WordPress PHP snippet uses to authenticate with the `/gclid-mapping` endpoint |

> `AUTHNET_LOGIN_ID` and `AUTHNET_TRANSACTION_KEY` are only needed for the webhook configuration endpoint. They are not required for normal webhook processing.

---

## 2. Run Locally

```bash
npm install
npm start
```

The server starts on `http://localhost:3000`. All endpoints are documented and testable at:

```
http://localhost:3000/api-docs
```

Swagger UI lets you inspect request/response schemas and fire test requests directly from the browser without needing a separate API client.

---

## 3. Initial Deployment on a DigitalOcean Node.js Droplet

These steps assume the droplet already has Node.js, nginx, and pm2 installed.

**On your local machine**, push the code to your repository.

**SSH into the droplet**, then:

```bash
# Clone the repo
git clone <your-repo-url> google-ads-webhook
cd google-ads-webhook

# Install dependencies
npm install

# Create and populate the .env file
cp .env.example .env
nano .env   # fill in all values per Section 1 above

# Start the app with pm2 (keeps it running after logout and on reboot)
pm2 start index.js --name google-ads-webhook
pm2 save
pm2 startup   # run the printed command to enable auto-start on reboot
```

**Configure nginx** to proxy traffic to the Node server. In your nginx site config (typically `/etc/nginx/sites-available/your-domain`):

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}
```

Then reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Verify the service is running:

```bash
pm2 status
curl http://localhost:3000/health
```

Visit the api docs to test and verify the server is accessible externally:
```
TODO
```

---

## 4. Updating the Server on an Existing Droplet

SSH into the droplet, then:

```bash
cd google-ads-webhook

# Pull latest changes
git pull

# Install any new dependencies
npm install

# Restart the app — pm2 will apply the new code
pm2 restart google-ads-webhook
```

If you added new environment variables, update `.env` before restarting:

```bash
nano .env
pm2 restart google-ads-webhook
```

Check the logs if anything looks wrong:

```bash
pm2 logs google-ads-webhook
```
