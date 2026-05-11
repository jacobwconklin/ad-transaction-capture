import { GoogleAdsApi } from 'google-ads-api';
import { sendErrorEmail } from './email.js';

// Shared API client — one instance for all sites.
// All sites must be sub-accounts under the same MCC so this single
// refresh token has access to every customer account.
const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

/**
 * sleep
 * Returns a Promise that resolves after `ms` milliseconds.
 * Used to implement backoff delays between retry attempts.
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * withRetry
 * Executes `fn` up to 3 times with exponential backoff (0s → 2s → 4s).
 * On final failure sends a Slack alert and returns without throwing so
 * the webhook response is never blocked by Google Ads errors.
 * @param {string} label - Human-readable label used in logs and Slack messages.
 * @param {Function} fn  - Async operation to attempt.
 */
const withRetry = async (label, fn) => {
  const delays = [0, 2000, 4000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      await fn();
      console.log(`[googleAds] ${label} succeeded on attempt ${attempt + 1}`);
      return;
    } catch (err) {
      console.error(`[googleAds] ${label} attempt ${attempt + 1} failed:`, err.message);
      if (attempt === delays.length - 1) {
        await sendErrorEmail(`Google Ads ${label} failed after 3 attempts: ${err.message}`).catch(() => {});
      }
    }
  }
};

/**
 * uploadConversion
 * Uploads a single click conversion to the Google Ads account specified by siteConfig.
 * Called after a successful payment capture (responseCode === 1).
 * @param {object} params
 * @param {string} params.gclid               - Google Click ID stored on the transaction.
 * @param {string} params.conversionDateTime  - ISO-style string: "2026-05-05 14:30:00+00:00"
 * @param {number} params.conversionValue     - Transaction amount.
 * @param {object} params.siteConfig          - Per-site config from the request body.
 */
const uploadConversion = async ({ gclid, conversionDateTime, conversionValue, siteConfig }) => {
  const { customerId, conversionActionId, currency } = siteConfig;

  await withRetry(`uploadConversion(domain=${siteConfig.domain})`, async () => {
    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    });

    await customer.conversionUploads.uploadClickConversions({
      customer_id: customerId,
      conversions: [
        {
          gclid,
          conversion_action: `customers/${customerId}/conversionActions/${conversionActionId}`,
          conversion_date_time: conversionDateTime,
          conversion_value: conversionValue,
          currency_code: currency,
        },
      ],
      partial_failure: false,
    });
  });
};

/**
 * uploadRefundAdjustment
 * Reports a full refund to Google Ads by restating the conversion value to 0.
 * Uses ConversionAdjustmentUploadService with type RESTATEMENT.
 * Called after a refund webhook is received and the original transaction is found.
 * @param {object} params
 * @param {string} params.gclid                    - Google Click ID from the original transaction.
 * @param {string} params.conversionDateTime       - Original conversion date/time string.
 * @param {string} params.adjustmentDateTime       - When the refund occurred.
 * @param {object} params.siteConfig               - Per-site config from the request body.
 */
const uploadRefundAdjustment = async ({ gclid, conversionDateTime, adjustmentDateTime, siteConfig }) => {
  const { customerId, conversionActionId } = siteConfig;

  await withRetry(`uploadRefundAdjustment(domain=${siteConfig.domain})`, async () => {
    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    });

    await customer.conversionAdjustments.uploadConversionAdjustments({
      customer_id: customerId,
      conversions: [
        {
          gclid_date_time_pair: {
            gclid,
            conversion_date_time: conversionDateTime,
          },
          conversion_action: `customers/${customerId}/conversionActions/${conversionActionId}`,
          adjustment_type: 'RESTATEMENT',
          adjustment_date_time: adjustmentDateTime,
          restatement_value: {
            adjusted_value: 0,
          },
        },
      ],
      partial_failure: false,
    });
  });
};

export { uploadConversion, uploadRefundAdjustment };
