# GCLID → Authorize.net → REST API Implementation Plan

## Goal

Track Google Ads click IDs (GCLIDs) through to successful Authorize.net payments on a WordPress site using WPForms.

## Architecture

```
User clicks Google Ad → lands on WordPress page with ?gclid=... in URL
    ↓
JavaScript captures GCLID from URL → stores in localStorage + cookie
    ↓
On form submit, JavaScript (wpformGclidCapture.js):
  1. Intercepts the submit event before WPForms processes it
  2. POSTs { gclid } to REST API → server inserts row, returns { ref_id } (serial PK)
  3. Injects ref_id into a hidden WPForms field
  4. Re-fires the submit event so WPForms takes over
    ↓
PHP hook reads ref_id from hidden field → sets it as invoiceNumber on the Authorize.net transaction
    ↓
Authorize.net processes payment → fires webhook to your REST API
    ↓
Your REST API:
  1. Receives webhook with transaction ID
  2. Reads invoiceNumber from payload (= ref_id)
  3. Queries gclid_mappings table by ref_id to retrieve GCLID
  4. Uploads offline conversion to Google Ads
```

## Piece 1: JavaScript — Capture GCLID Into Hidden Form Field

Add this via WPCode (Code Snippets → Add New → JavaScript type) or in your theme.
The hidden field must already exist in your WPForms form. Replace `FIELD_ID` with the
actual CSS ID of your hidden field (inspect the form HTML to find it).

```javascript
document.addEventListener('DOMContentLoaded', function () {
  var params = new URLSearchParams(window.location.search);
  var gclid = params.get('gclid');

  if (gclid) {
    // Try setting it on page load
    var field = document.getElementById('wpforms-FORM_ID-field_FIELD_ID');
    if (field) {
      field.value = gclid;
    }

    // Also store in cookie in case user navigates before submitting
    document.cookie = 'gclid=' + encodeURIComponent(gclid) +
      ';max-age=2592000;path=/;SameSite=Lax';
  }

  // On form render, try to fill from cookie if field is empty
  var allHidden = document.querySelectorAll('input[type="hidden"]');
  allHidden.forEach(function (input) {
    if (input.id && input.id.includes('field_FIELD_ID') && !input.value) {
      var match = document.cookie.match(/gclid=([^;]+)/);
      if (match) {
        input.value = decodeURIComponent(match[1]);
      }
    }
  });
});
```

## Piece 2: PHP — Read ref_id from Hidden Field, Inject Into Transaction

The JavaScript already saved the mapping and populated the hidden ref_id field before the
form submitted, so the PHP only needs to read that value and pass it to Authorize.net.

Add this via WPCode (Code Snippets → Add New → PHP type → Run Everywhere).
Replace `YOUR_REF_ID_FIELD_ID` with the numeric field ID of the hidden ref_id field.

```php
<?php
/**
 * Step 1: Read ref_id from the hidden form field (populated by JS before submit).
 */
add_filter(
    'wpforms_authorize_net_process_payment_single_args',
    function ($args, $process) {
        $ref_id = $process->fields[YOUR_REF_ID_FIELD_ID]['value'] ?? '';
        if (empty($ref_id)) {
            return $args;
        }

        $args['ref_id'] = $ref_id;
        return $args;
    },
    10,
    2
);

/**
 * Step 2: Set ref_id as invoiceNumber on the Authorize.net transaction.
 */
add_filter(
    'wpforms_authorize_net_process_transaction',
    function ($transaction, $args) {
        if (empty($args['ref_id'])) {
            return $transaction;
        }

        $order = $transaction->getOrder();
        if (is_null($order)) {
            $order = new \net\authorize\api\contract\v1\OrderType();
        }

        $order->setInvoiceNumber($args['ref_id']);
        $transaction->setOrder($order);

        return $transaction;
    },
    10,
    2
);
```

## Piece 3: REST API Endpoints (Your Server)

Your REST API needs two endpoints:

### 3a. Save GCLID Mapping (called by the browser JS on form submit)

```
POST /gclid-mapping
Body: { "gclid": "EAIaIQob..." }
Auth: Bearer token

→ INSERT INTO gclid_mappings (gclid) VALUES ($1) RETURNING id
→ Return 200 { "ref_id": 42 }   ← serial PK, collision-free by construction
```

### 3b. Authorize.net Webhook Handler (called by Authorize.net on payment success)

```
POST /authorize-webhook

Steps:
  1. Parse payload → extract payload.id (Authorize.net transaction ID)
  2. Call Authorize.net "Get Transaction Details" API with that ID
  3. Read order.invoiceNumber from response → this is your ref_id
  4. Query your database for the GCLID matching that ref_id
  5. Process the GCLID however you need (e.g., send offline conversion to Google Ads)
  6. Always return HTTP 200 to Authorize.net (even on errors — otherwise it retries)
```

## Setup Checklist

- [ ] Create a hidden field in your WPForms form for the GCLID
- [ ] Note the form ID and field ID (WPForms → edit form → click the field → check Field Options)
- [ ] Add the JavaScript snippet via WPCode (set type to JavaScript)
- [ ] Add the PHP snippet via WPCode (set type to PHP, insertion: Run Everywhere)
- [ ] Replace all placeholder values (FORM_ID, FIELD_ID, API URL, API key)
- [ ] Build the two REST API endpoints on your server
- [ ] In Authorize.net dashboard: Account → Webhooks → add your webhook URL
- [ ] Subscribe to event: `net.authorize.payment.authcapture.created`
- [ ] Test end to end with a sandbox transaction