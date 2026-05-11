import https from 'https';

/**
 * notifySlack
 * Sends a plain-text error message to the configured Slack webhook URL.
 * Fire-and-forget — callers should not depend on this resolving before continuing.
 * @param {string} message - Human-readable description of the error.
 */
const notifySlack = async (message) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[slack] SLACK_WEBHOOK_URL not set — skipping notification');
    return;
  }

  const body = JSON.stringify({ text: `[google-ads-webhook] ${message}` });
  const url = new URL(webhookUrl);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve();
      }
    );
    req.on('error', (err) => {
      console.error('[slack] Failed to send notification:', err.message);
      reject(err);
    });
    req.write(body);
    req.end();
  });
};

export { notifySlack };
