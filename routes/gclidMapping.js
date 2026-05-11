import express from 'express';
import { insertGclidMapping } from '../services/db.js';

const router = express.Router();

const verifyApiKey = (req, res, next) => {
  const expected = 'Bearer ' + process.env.GCLID_MAPPING_API_KEY;
  if (req.headers['authorization'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

/**
 * POST /gclid-mapping
 * Called by wpformGclidCapture.js immediately before WPForms submits the payment form.
 * Persists the GCLID and returns the row's serial id as ref_id — the browser injects
 * this into a hidden field so the PHP hook can set it as Authorize.net's invoiceNumber.
 * The serial PK is the ref_id, so collisions are impossible by construction.
 */
router.post('/', verifyApiKey, async (req, res) => {
  const { gclid } = req.body;

  if (!gclid || typeof gclid !== 'string' || gclid.trim() === '') {
    return res.status(400).json({ error: 'gclid is required' });
  }

  try {
    const refId = await insertGclidMapping(gclid.trim());
    return res.status(200).json({ ref_id: refId });
  } catch (err) {
    console.error('[gclid-mapping] Insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to save mapping' });
  }
});

export default router;
