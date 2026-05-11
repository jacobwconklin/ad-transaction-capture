import express from 'express';
import verifySignature from '../middleware/verifySignature.js';
import {
  insertTransaction,
  getTransactionByAuthnetId,
  updateTransactionStatus,
} from '../services/db.js';
import { uploadConversion, uploadRefundAdjustment, formatConversionDateTime } from '../services/googleAds.js';

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

const handleAuthCapture = async ({ authorizeNetPayload, siteConfig }) => {
  const payload = authorizeNetPayload;
  const transactionId = payload?.payload?.id;
  const responseCode = payload?.payload?.responseCode;
  const amount = payload?.payload?.authAmount;

  // Custom fields are an array of { fieldName, fieldValue } objects.
  const customFields = payload?.payload?.customFields || [];
  const gclidField = customFields.find((f) => f.fieldName === 'hidden_gclid');
  const gclid = gclidField?.fieldValue || null;

  if (!transactionId || amount === undefined) {
    console.error('[webhook/authcapture] Missing transactionId or amount in payload');
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
    return;
  }

  // Only upload a conversion for successful captures.
  if (responseCode !== 1) {
    console.log(`[webhook/authcapture] Payment not successful (responseCode=${responseCode}), skipping conversion`);
    return;
  }

  if (!gclid) {
    console.warn(`[webhook/authcapture] No gclid for txn=${transactionId} domain=${siteConfig.domain}, skipping conversion`);
    return;
  }

  uploadConversion({
    gclid,
    conversionDateTime: formatConversionDateTime(new Date()),
    conversionValue: parseFloat(amount),
    siteConfig,
  }).catch((err) => {
    console.error('[webhook/authcapture] Unhandled uploadConversion error:', err.message);
  });
};

const handleRefund = async ({ authorizeNetPayload, siteConfig }) => {
  const payload = authorizeNetPayload;
  const transactionId = payload?.payload?.id;

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
    console.warn(`[webhook/refund] Original transaction not found for txn=${transactionId} — skipping`);
    return;
  }

  // Mark the row refunded regardless of whether a Google Ads gclid exists.
  await updateTransactionStatus(transactionId, 'refunded').catch(() => {
    // updateTransactionStatus already logged the error; continue to attempt Google Ads upload.
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
};

/**
 * @openapi
 * /webhook/authorizenet:
 *   post:
 *     summary: Receive an Authorize.net payment webhook
 *     description: >
 *       Handles `net.authorize.payment.authcapture.created` and
 *       `net.authorize.payment.refund.created` events. Persists the transaction
 *       and uploads a conversion (or refund adjustment) to Google Ads.
 *       Always returns 200 so Authorize.net does not retry delivery.
 *     security:
 *       - hmacSignature: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [authorizeNetPayload, siteConfig]
 *             properties:
 *               authorizeNetPayload:
 *                 type: object
 *                 description: Raw event object forwarded from Authorize.net
 *                 properties:
 *                   eventType:
 *                     type: string
 *                     example: net.authorize.payment.authcapture.created
 *                   payload:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: '60032737027'
 *                       responseCode:
 *                         type: integer
 *                         example: 1
 *                       authAmount:
 *                         type: number
 *                         example: 199.99
 *                       customFields:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             fieldName:
 *                               type: string
 *                             fieldValue:
 *                               type: string
 *               siteConfig:
 *                 type: object
 *                 required: [domain, currency, conversionActionId, customerId]
 *                 properties:
 *                   domain:
 *                     type: string
 *                     example: example.com
 *                   currency:
 *                     type: string
 *                     example: USD
 *                   conversionActionId:
 *                     type: string
 *                     example: '123456789'
 *                   customerId:
 *                     type: string
 *                     example: '987-654-3210'
 *     responses:
 *       200:
 *         description: Event received (always returned so Authorize.net does not retry)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 */
router.post('/authorizenet', verifySignature, async (req, res) => {
  // Respond 200 immediately — processing runs after the response is sent.
  res.status(200).json({ received: true });

  const { authorizeNetPayload, siteConfig } = req.body;
  const eventType = authorizeNetPayload?.eventType;

  console.log(
    `[webhook] Received event eventType=${eventType} domain=${siteConfig?.domain} ` +
      `at=${new Date().toISOString()}`
  );

  // TODO Remove and restore below, temporarily printing entire webhook and then exiting. 
  console.log('[webhook] Full webhook payload:', JSON.stringify(req.body, null, 2));
  return;

  // const configError = validateSiteConfig(siteConfig);
  // if (configError) {
  //   console.error('[webhook] Invalid siteConfig:', configError);
  //   return;
  // }

  // if (!authorizeNetPayload) {
  //   console.error('[webhook] Missing authorizeNetPayload');
  //   return;
  // }

  // if (eventType === 'net.authorize.payment.refund.created') {
  //   await handleRefund({ authorizeNetPayload, siteConfig });
  // } else if (eventType === 'net.authorize.payment.authcapture.created') {
  //   await handleAuthCapture({ authorizeNetPayload, siteConfig });
  // } else {
  //   console.warn(`[webhook] Unhandled eventType=${eventType}, ignoring`);
  // }
});

export default router;
