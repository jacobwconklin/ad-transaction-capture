import express from 'express';
import verifySignature from '../middleware/verifySignature.js';
import {
  insertTransaction,
  getTransactionByAuthnetId,
  updateTransactionStatus,
} from '../services/db.js';
import { uploadConversion, uploadRefundAdjustment } from '../services/googleAds.js';

const router = express.Router();

/**
 * validateSiteConfig
 * Returns a validation error string if any required siteConfig field is absent,
 * otherwise returns null. Keeps both endpoints consistent on what's required.
 * @param {object} siteConfig
 * @returns {string|null}
 */
const validateSiteConfig = (siteConfig) => {
  if (!siteConfig) return 'siteConfig is required';
  const required = ['domain', 'currency', 'conversionActionId', 'customerId'];
  for (const key of required) {
    if (!siteConfig[key]) return `siteConfig.${key} is required`;
  }
  return null;
};

/** // TODO move this to googleAds service
 * formatConversionDateTime
 * Converts a JS Date (or ISO string) to the format Google Ads expects:
 * "YYYY-MM-DD HH:MM:SS+00:00"
 * @param {Date|string} date
 * @returns {string}
 */
const formatConversionDateTime = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
};

/** // TODO rename to "capture payment" or something similar
 * POST /webhook/authorizenet
 * Receives a payment capture event from Authorize.net.
 * Verifies the HMAC signature, persists the transaction, and (if successful)
 * fires a Google Ads conversion upload in the background.
 * Always returns 200 so Authorize.net does not retry the delivery.
 */
router.post('/authorizenet', verifySignature, async (req, res) => {
  // Respond 200 immediately — Google Ads upload runs after the response is sent.
  res.status(200).json({ received: true });

  const { authorizeNetPayload, siteConfig } = req.body;

  // Log every incoming webhook for audit trail before any processing.
  console.log(
    `[webhook] Received authcapture event domain=${siteConfig?.domain} ` +
      `at=${new Date().toISOString()}`
  );

  const configError = validateSiteConfig(siteConfig);
  if (configError) {
    console.error('[webhook] Invalid siteConfig:', configError);
    return;
  }

  if (!authorizeNetPayload) {
    console.error('[webhook] Missing authorizeNetPayload');
    return;
  }

  // Extract fields from the Authorize.net payload.
  // The gclid is stored as a custom field on the transaction.
  const payload = authorizeNetPayload;
  const transactionId = payload?.payload?.id;
  const responseCode = payload?.payload?.responseCode;
  const amount = payload?.payload?.authAmount;

  // Custom fields are an array of { fieldName, fieldValue } objects.
  const customFields = payload?.payload?.customFields || [];
  const gclidField = customFields.find((f) => f.fieldName === 'hidden_gclid');
  const gclid = gclidField?.fieldValue || null;

  if (!transactionId || amount === undefined) {
    console.error('[webhook] Missing transactionId or amount in payload');
    return;
  }

  // Persist the transaction regardless of payment outcome.
  try {
    await insertTransaction({
      authnetTransactionId: transactionId,
      siteDomain: siteConfig.domain,
      gclid,
      amount,
      currency: siteConfig.currency,
      conversionActionId: siteConfig.conversionActionId,
      customerId: siteConfig.customerId,
      status: responseCode === 1 ? 'captured' : 'declined',
      rawPayload: payload,
    });
  } catch {
    // insertTransaction already notified Slack and logged the error.
    return;
  }

  // Only upload a conversion for successful captures.
  if (responseCode !== 1) {
    console.log(`[webhook] Payment not successful (responseCode=${responseCode}), skipping conversion`);
    return;
  }

  if (!gclid) {
    console.warn(`[webhook] No gclid for txn=${transactionId} domain=${siteConfig.domain}, skipping conversion`);
    return;
  }

  // Fire conversion upload — errors are caught inside uploadConversion with retry + Slack alert.
  uploadConversion({
    gclid,
    conversionDateTime: formatConversionDateTime(new Date()),
    conversionValue: parseFloat(amount),
    siteConfig,
  }).catch((err) => {
    console.error('[webhook] Unhandled uploadConversion error:', err.message);
  });
});


/** // TODO also rename
 * POST /webhook/authorizenet/refund
 * Receives a refund event from Authorize.net (net.authorize.payment.refund.created).
 * Looks up the original transaction to retrieve the stored gclid, then updates the
 * transaction status and uploads a conversion adjustment to Google Ads.
 * Always returns 200 so Authorize.net does not retry the delivery.
 */
router.post('/authorizenet/refund', verifySignature, async (req, res) => {
  // Respond 200 immediately — processing runs after the response is sent.
  res.status(200).json({ received: true });

  const { authorizeNetPayload, siteConfig } = req.body;

  console.log(
    `[webhook] Received refund event domain=${siteConfig?.domain} ` +
      `at=${new Date().toISOString()}`
  );

  const configError = validateSiteConfig(siteConfig);
  if (configError) {
    console.error('[webhook/refund] Invalid siteConfig:', configError);
    return;
  }

  if (!authorizeNetPayload) {
    console.error('[webhook/refund] Missing authorizeNetPayload');
    return;
  }

  const payload = authorizeNetPayload;
  const transactionId = payload?.payload?.id;
  const refundAmount = payload?.payload?.authAmount;

  if (!transactionId) {
    console.error('[webhook/refund] Missing transactionId in payload');
    return;
  }

  // Look up the original transaction to get the stored gclid.
  const original = await getTransactionByAuthnetId(transactionId).catch((err) => {
    console.error('[webhook/refund] DB lookup failed:', err.message);
    return null;
  });

  if (!original) {
    // Authorize.net may send refund events for transactions we never captured (e.g. test mode).
    // Log and exit — do not error so Authorize.net won't retry.
    console.warn(`[webhook/refund] Original transaction not found for txn=${transactionId} — skipping`);
    return;
  }

  // Mark the row refunded regardless of whether a Google Ads gclid exists.
  await updateTransactionStatus(transactionId, 'refunded').catch(() => {
    // updateTransactionStatus already notified Slack; continue to attempt Google Ads upload.
  });

  if (!original.gclid) {
    console.warn(`[webhook/refund] No gclid on original txn=${transactionId}, skipping adjustment`);
    return;
  }

  // Upload a restatement adjustment that sets the conversion value to 0 (full refund).
  uploadRefundAdjustment({
    gclid: original.gclid,
    conversionDateTime: formatConversionDateTime(original.created_at),
    adjustmentDateTime: formatConversionDateTime(new Date()),
    siteConfig,
  }).catch((err) => {
    console.error('[webhook/refund] Unhandled uploadRefundAdjustment error:', err.message);
  });
});

export default router;
