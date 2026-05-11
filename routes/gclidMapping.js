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
 * @openapi
 * /gclid-mapping:
 *   post:
 *     summary: Store a GCLID before payment form submission
 *     description: >
 *       Called server-side by the WordPress PHP hook when a WPForms payment form is
 *       submitted. The browser JavaScript only reads the gclid from the URL and writes
 *       it into a hidden form field — the PHP hook makes this request so the Bearer
 *       token never appears in browser source. Persists the GCLID and returns a ref_id
 *       that the PHP hook sets as the Authorize.net invoiceNumber.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gclid]
 *             properties:
 *               gclid:
 *                 type: string
 *                 example: CjwKCAjw123abc
 *     responses:
 *       200:
 *         description: Mapping saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ref_id:
 *                   type: integer
 *                   example: 42
 *       400:
 *         description: Missing or invalid gclid
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid Bearer token
 *       500:
 *         description: Database error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', verifyApiKey, async (req, res) => {
  const { gclid } = req.body;

  if (!gclid || typeof gclid !== 'string' || gclid.trim() === '') {
    console.log('[gclid-mapping] Insert failed GCLID not found');
    return res.status(400).json({ error: 'gclid is required' });
  }

  try {
    const refId = await insertGclidMapping(gclid.trim());
    console.log('[gclid-mapping] Successfully inserted GCLID');
    return res.status(200).json({ ref_id: refId });
  } catch (err) {
    console.error('[gclid-mapping] Insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to save mapping' });
  }
});

export default router;
