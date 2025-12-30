/**
 * controllers/reconcilerController.js
 *
 * Simple controller that triggers the paymentRetry reconcile job.
 * Accepts: limit, concurrency, dryRun, runBy via body or query string.
 *
 * Example:
 *  POST /api/reconcile
 *  { "limit": 50, "concurrency": 5, "dryRun": false }
 */

const {reconcileOnce} = require('../services/paymentRetry');


exports.run = async (req, res) => {
  try {
    const limit = Number(req.body.limit || 50);
    const dryRun = Boolean(req.body.dryRun);
    const runBy = req.userId || 'admin';

    const result = await reconcileOnce({
      limit,
      dryRun,
      runBy
    });

    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[reconcilerController] run error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};


