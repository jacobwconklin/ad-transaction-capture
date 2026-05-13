import express from 'express';
import verifySignature from '../middleware/verifySignature.js';
import {
  insertTransaction,
  getTransactionByAuthnetId,
  updateTransactionStatus,
  getMappingByRefId,
  getDomainById,
} from '../services/db.js';
import { uploadConversion, uploadRefundAdjustment, formatConversionDateTime } from '../services/googleAds.js';

const router = express.Router();

const handleAuthCapture = async ({ payload, gclid, siteConfig }) => {
  const transactionId = payload?.payload?.id;
  const responseCode = payload?.payload?.responseCode;
  const amount = payload?.payload?.authAmount;

  if (!transactionId || amount === undefined) {
    console.error('[webhook/authcapture] Missing transactionId or amount in payload');
    return;
  }

  // Persist the transaction regardless of payment outcome.
  try {
    await insertTransaction({
      authnetTransactionId: transactionId,
      siteDomain: siteConfig.customerId,
      gclid,
      amount,
      currency: siteConfig.currency,
      conversionActionId: siteConfig.conversionActionId,
      customerId: siteConfig.customerId,
      status: responseCode === 1 ? 'captured' : 'declined',
    });
  } catch {
    return;
  }

  // Only upload a conversion for successful captures.
  if (responseCode !== 1) {
    console.log(`[webhook/authcapture] Payment not successful (responseCode=${responseCode}), skipping conversion`);
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

const handleRefund = async ({ payload, gclid, siteConfig }) => {
  const transactionId = payload?.payload?.id;

  if (!transactionId) {
    console.error('[webhook/refund] Missing transactionId in payload');
    return;
  }

  // Look up the original transaction to get its created_at for the adjustment timestamp.
  const original = await getTransactionByAuthnetId(transactionId).catch((err) => {
    console.error('[webhook/refund] DB lookup failed:', err.message);
    return null;
  });

  if (!original) {
    console.warn(`[webhook/refund] Original transaction not found for txn=${transactionId} — skipping`);
    return;
  }

  // Mark the row refunded regardless of whether the Google Ads upload succeeds.
  await updateTransactionStatus(transactionId, 'refunded').catch(() => {
    // updateTransactionStatus already logged the error; continue to attempt Google Ads upload.
  });

  // Upload a restatement adjustment that sets the conversion value to 0 (full refund).
  uploadRefundAdjustment({
    gclid,
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
 *       `net.authorize.payment.refund.created` events. Resolves the gclid from
 *       the merchantReferenceId in the payload, then persists the transaction and
 *       uploads a conversion (or refund adjustment) to Google Ads.
 *       Always returns 200 so Authorize.net does not retry delivery.
 *     security:
 *       - hmacSignature: []
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

  const eventType = req.body?.eventType;
  const merchantReferenceId = req.body?.payload?.merchantReferenceId;

  console.log(
    `[webhook] Received authorize.net event eventType=${eventType} at=${new Date().toISOString()}`
  );

  // TODO: Remove once payload shape is confirmed in prod.
  console.log('[webhook] Full webhook payload:', JSON.stringify(req.body, null, 2));

  // merchantReferenceId is only present when the transaction originated from a Google Ad click.
  if (!merchantReferenceId) {
    console.log('[webhook] No merchantReferenceId in payload — transaction did not come from a Google Ad click, ignoring');
    return;
  }

  const mapping = await getMappingByRefId(merchantReferenceId).catch((err) => {
    console.error('[webhook] getMappingByRefId failed:', err.message);
    return null;
  });

  if (!mapping) {
    console.warn(`[webhook] No mapping found for merchantReferenceId=${merchantReferenceId}, ignoring`);
    return;
  }

  const { gclid, domainId } = mapping;

  const siteConfig = await getDomainById(domainId).catch((err) => {
    console.error('[webhook] getDomainById failed:', err.message);
    return null;
  });

  if (!siteConfig) {
    console.warn(`[webhook] No domain config found for domainId=${domainId}, ignoring`);
    return;
  }

  if (eventType === 'net.authorize.payment.refund.created') {
    await handleRefund({ payload: req.body, gclid, siteConfig });
  } else if (eventType === 'net.authorize.payment.authcapture.created') {
    await handleAuthCapture({ payload: req.body, gclid, siteConfig });
  } else {
    console.warn(`[webhook] Unhandled eventType=${eventType}, ignoring`);
  }
});

export default router;
