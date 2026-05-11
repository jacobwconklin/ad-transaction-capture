import nodemailer from 'nodemailer';

/**
 * sendErrorEmail
 * Sends a plain-text error notification to the configured recipient.
 * Fire-and-forget — callers should not depend on this resolving before continuing.
 * @param {string} message - Human-readable description of the error.
 */
const sendErrorEmail = async (message) => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ERROR_EMAIL_TO } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ERROR_EMAIL_TO) {
    console.warn('[email] SMTP config incomplete — skipping error notification');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: parseInt(SMTP_PORT || '587', 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to: ERROR_EMAIL_TO,
      subject: '[google-ads-webhook] Error',
      text: message,
    });
  } catch (err) {
    console.error('[email] Failed to send error notification:', err.message);
  }
};

export { sendErrorEmail };
