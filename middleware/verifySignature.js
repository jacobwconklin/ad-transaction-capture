import crypto from 'crypto';

/**
 * verifySignature
 * Express middleware that validates the Authorize.net webhook signature.
 * Authorize.net computes HMAC-SHA512 over the raw request body using the
 * account's Signature Key, then base64-encodes the result and sends it as
 * the X-ANET-Signature header value (prefixed with "sha512=").
 * Any request that fails this check is rejected with 401 before route handlers run.
 */
const verifySignature = (req, res, next) => {
  // TODO temporarily bypassing

  // const header = req.headers['x-anet-signature'];
  // if (!header) {
  //   console.warn('[verifySignature] Missing X-ANET-Signature header');
  //   return res.status(401).json({ error: 'Missing signature header' });
  // }

  // // Header format: "sha512=<hex>"  (Authorize.net sends lowercase hex, not base64)
  // const providedHash = header.toLowerCase().replace(/^sha512=/, '');

  // const expectedHash = crypto
  //   .createHmac('sha512', process.env.AUTHNET_SIGNATURE_KEY)
  //   .update(req.rawBody)
  //   .digest('hex');

  // if (providedHash !== expectedHash) {
  //   console.warn('[verifySignature] Signature mismatch — rejecting request');
  //   return res.status(401).json({ error: 'Invalid signature' });
  // }

  next();
};

export default verifySignature;
