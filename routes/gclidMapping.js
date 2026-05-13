import express from 'express';
import { upsertDomain, insertGclidMapping } from '../services/db.js';

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
 *     summary: Store a GCLID and site config before payment form submission
 *     description: >
 *       Called server-side by the WordPress PHP hook when a WPForms payment form is
 *       submitted. The browser JavaScript only reads the gclid from the URL and writes
 *       it into a hidden form field — the PHP hook makes this request so the Bearer
 *       token never appears in browser source. Upserts the site's domain config into
 *       the domains table, persists the GCLID with the domain_id, and returns a ref_id
 *       that the PHP hook sets as the Authorize.net invoiceNumber.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gclid, currency, conversion_action_id, customer_id]
 *             properties:
 *               gclid:
 *                 type: string
 *                 example: CjwKCAjw123abc
 *               currency:
 *                 type: string
 *                 example: USD
 *               conversion_action_id:
 *                 type: string
 *                 example: '123456789'
 *               customer_id:
 *                 type: string
 *                 example: '1234567890'
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
  const { gclid, currency, conversion_action_id, customer_id } = req.body;

  if (!gclid || typeof gclid !== 'string' || gclid.trim() === '') {
    return res.status(400).json({ error: 'gclid is required' });
  }
  if (!currency || !conversion_action_id || !customer_id) {
    return res.status(400).json({ error: 'currency, conversion_action_id, and customer_id are required' });
  }

  try {
    const domainId = await upsertDomain({
      currency,
      conversionActionId: conversion_action_id,
      customerId: customer_id,
    });
    const refId = await insertGclidMapping({ gclid: gclid.trim(), domainId });
    console.log(`[gclid-mapping] Inserted gclid for domainId=${domainId} refId=${refId}`);
    return res.status(200).json({ ref_id: refId });
  } catch (err) {
    console.error('[gclid-mapping] Insert failed:', err.message);
    return res.status(500).json({ error: 'Failed to save mapping' });
  }
});

export default router;
