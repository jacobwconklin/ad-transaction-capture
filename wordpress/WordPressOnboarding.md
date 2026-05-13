# WordPress Site Onboarding Guide

Step-by-step checklist for connecting a new WordPress/WPForms/Authorize.net site to the shared Google Ads conversion tracking server.

---

## Step 1 — Create a Hidden Field in WPForms

Open the client's WordPress admin, go to **WPForms → Edit Form** for the payment form.

Add one **Hidden** field type:

| Field | Label (suggested) | Purpose |
|-------|-------------------|---------|
| Hidden field | `Ref ID` | Stores the database reference ID returned by the mapping API |

After saving, open the field's settings and note its **numeric field ID** from the URL or the field panel (e.g. field `5`). You will need this in Steps 2 and 3.

---

## Step 2 — Add the JavaScript Snippet (WPCode)

Install the **WPCode** plugin if not already present (`Plugins → Add New → WPCode`).

Go to **Code Snippets → Add Snippet → Add Your Custom Code**.

| Setting | Value |
|---------|-------|
| Snippet type | **JavaScript** |
| Insert location | **Site Wide Header** (runs on every page) |
| Script type | **Module** (`type="module"`) |

Paste the full contents of `captureGclid.js`, then fill in the `CONFIG` block at the top:

```javascript
const CONFIG = {
  formId:       '123', // WPForms form ID (WPForms → All Forms → hover form name → form_id= in URL)
  refIdFieldId: '5',   // Hidden Ref ID field ID from Step 1
};
```

Activate the snippet and save.

---

## Step 3 — Add the PHP Snippet (WPCode)

Still in WPCode, add a second snippet.

| Setting | Value |
|---------|-------|
| Snippet type | **PHP** |
| Insert location | **Run Everywhere** |

Paste the full contents of `saveGclid.php`, then fill in the placeholders:

| Placeholder | Replace with |
|-------------|-------------|
| `YOUR_MAPPING_API_KEY` | API key from the shared server `.env` → `GCLID_MAPPING_API_KEY` |
| `YOUR_MAPPING_API_URL` | Public URL of the shared server, e.g. `https://your-api.com/gclid-mapping` |
| `YOUR_REF_ID_FIELD_ID` | Numeric field ID of the Ref ID hidden field from Step 1 (e.g. `5`) |
| `YOUR_CURRENCY` | The site's billing currency, e.g. `USD`, `CAD`, or `EUR` |
| `YOUR_CONVERSION_ACTION_ID` | The Google Ads conversion action ID for this site (found in Google Ads → Goals → Conversions → click the action → the numeric ID in the URL) |
| `YOUR_CUSTOMER_ID` | The Google Ads customer ID for this site (10-digit number shown in the top-right of Google Ads, without dashes) |

> **Important:** `YOUR_CURRENCY`, `YOUR_CONVERSION_ACTION_ID`, and `YOUR_CUSTOMER_ID` are hardcoded per-site directly in the PHP snippet. These values are sent to the mapping API on every form submission so the server can store this site's config without any manual server-side setup per client.

This single snippet:
- Registers a WordPress REST endpoint at `/wp-json/gclid/v1/save` that proxies the gclid (and site config) to the mapping API using the key server-side
- Passes the returned `ref_id` to Authorize.net as the invoice number

Activate and save.

---

## Step 4 — Verify the Flow End-to-End

### 4a. Check GCLID capture
Visit a page on the site with `?gclid=test123` in the URL (e.g. `https://client-site.com/checkout?gclid=test123`).

Open browser DevTools → Application → Local Storage and Cookies. Confirm:
- `gclid = test123` is present in both localStorage and cookies.

### 4b. Check the mapping API call
Open DevTools → Network. Submit the form (use a test/sandbox Authorize.net environment). Confirm a `POST` request to `/wp-json/gclid/v1/save` fires before the form submits, returns `200`, and the response contains `{ "ref_id": <number> }`.

### 4c. Check the hidden Ref ID field
After the mapping API call, confirm the Ref ID hidden field (`wpforms-FORMID-field_REFIDID`) has its value set to the returned `ref_id`.

### 4d. Check the webhook arrives at the server
After the test transaction completes, check the server logs for:
```
[webhook] Received authcapture for transaction <id> on client-site.com
[googleAds] uploadConversion(domain=client-site.com) succeeded on attempt 1
```

If the Google Ads upload fails, a Slack alert will fire. Check Slack for error details.

---

## Quick-Reference Checklist

```
[ ] Collected: mappingApiKey, mappingApiUrl
[ ] Collected: currency, conversion_action_id, customer_id for this site
[ ] Step 1 — Created one WPForms hidden field (Ref ID); noted its numeric field ID
[ ] Step 2 — Added captureGclid.js via WPCode (type: JavaScript, type=module); filled CONFIG
[ ] Step 3 — Added saveGclid.php via WPCode (type: PHP, Run Everywhere); filled all placeholders
           including YOUR_CURRENCY, YOUR_CONVERSION_ACTION_ID, YOUR_CUSTOMER_ID
[ ] Step 4 — Verified GCLID capture, field population, API call, and Google Ads upload end-to-end
```
