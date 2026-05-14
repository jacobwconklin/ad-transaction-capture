import express from 'express';
import {
  insertTransaction,
  getTransactionByRefId,
  markTransactionRefunded,
  getMappingByRefId,
  getDomainById,
} from '../services/db.js';
import { uploadConversion, uploadRefundAdjustment, formatConversionDateTime } from '../services/googleAds.js';

const router = express.Router();

const handleAuthCapture = async ({ payload, refId, gclid, siteConfig }) => {
  const transactionId = payload?.payload?.id;
  const amount = payload?.payload?.authAmount;

  if (!transactionId || amount === undefined) {
    console.error('[webhook/authcapture] Missing transactionId or amount in payload');
    return;
  }

  try {
    await insertTransaction({ authnetTransactionId: transactionId, refId, amount });
  } catch {
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

const handleRefund = async ({ refId, gclid, siteConfig }) => {
  // Look up the original captured transaction by ref_id.
  // Refund webhooks carry a new authnet transaction ID, so we can't use that to find the original row.
  const original = await getTransactionByRefId(refId).catch((err) => {
    console.error('[webhook/refund] DB lookup failed:', err.message);
    return null;
  });

  if (!original) {
    console.warn(`[webhook/refund] Original captured transaction not found for ref_id=${refId} — skipping`);
    return;
  }

  // Mark the row refunded regardless of whether the Google Ads upload succeeds.
  await markTransactionRefunded(refId).catch(() => {
    // markTransactionRefunded already logged the error; continue to attempt Google Ads upload.
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
router.post('/authorizenet', async (req, res) => {
  // Respond 200 immediately — processing runs after the response is sent.
  res.status(200).json({ received: true });

  const eventType = req.body?.eventType;
  const merchantReferenceId = req.body?.payload?.merchantReferenceId;

  console.log(
    `[webhook] Received authorize.net event eventType=${eventType} at=${new Date().toISOString()}`
  );

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
    await handleRefund({ refId: parseInt(merchantReferenceId, 10), gclid, siteConfig });
  } else if (eventType === 'net.authorize.payment.authcapture.created') {
    await handleAuthCapture({ payload: req.body, refId: merchantReferenceId, gclid, siteConfig });
  } else {
    console.warn(`[webhook] Unhandled eventType=${eventType}, ignoring`);
  }
});

export default router;
