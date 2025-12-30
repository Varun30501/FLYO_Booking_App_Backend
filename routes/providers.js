const express = require('express');
const router = express.Router();
const adapter = require('../services/airlines/adapter'); // use adapter so fallback providers work
const providersCtrl = require('../controllers/providersController');

// /api/providers/search?origin=&destination=&date=&limit=
router.get('/search', async (req, res) => {
  try {
    const { origin, destination, date, limit } = req.query;
    const results = await adapter.search({ origin, destination, date, limit: Number(limit) || 20 });
    return res.json({ ok: !!results.ok, flights: results.flights, diagnostic: results.diagnostic });
  } catch (e) {
    console.error('[providers] search error', e && e.message);
    res.status(500).json({ ok: false, error: 'provider search failed', detail: e && (e.message || String(e)) });
  }
});

router.get('/status', providersCtrl.status);

module.exports = router;
