// routes/adminReconcile.js
const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const ReconciliationLog = require('../models/ReconciliationLog');
const { reconcileOnce } = require('../services/paymentRetry');

const router = express.Router();

/**
 * POST /api/admin/reconcile
 */
router.post('/', adminAuth, async (req, res) => {
  try {
    const result = await reconcileOnce({
      limit: Number(req.body.limit || 50),
      dryRun: Boolean(req.body.dryRun),
      runBy: req.userId || 'admin'
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[adminReconcile] run error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/admin/reconcile/logs
 */
router.get("/logs", adminAuth, async (req, res) => {
  try {
    const limit = Math.min(
      Number(req.query.limit || 100), // frontend can override
      500 // hard safety cap
    );

    const logs = await ReconciliationLog
      .find({})
      .sort({ runAt: -1, _id: -1 }) // 🔑 stable ordering
      .limit(limit)
      .lean();

    res.json({ ok: true, logs });
  } catch (err) {
    console.error("[adminReconcile] logs error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


/**
 * GET /api/admin/reconcile/logs/:id
 */
router.get('/logs/:id', adminAuth, async (req, res) => {
  const log = await ReconciliationLog.findById(req.params.id).lean();
  if (!log) return res.status(404).json({ ok: false, error: 'Log not found' });
  res.json({ ok: true, log });
});

module.exports = router;
