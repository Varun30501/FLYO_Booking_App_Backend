// routes/airline.js
const express = require('express');
const router = express.Router();
const airlines = require('../services/airlines/adapter');
const Airlines = require('../models/Airlines');

// POST /api/airline/seed
// Body: { provider: 'mock', flights: [ { flightNumber, airline, origin, destination, departureAt, arrivalAt, price } ] }
router.post('/seed', async (req, res) => {
    try {
        const { provider, flights } = req.body || {};
        const providerName = provider || process.env.AIRLINE_PROVIDER || 'mock';
        const seeded = await airlines.seedProvider(providerName, flights || []);
        res.json({ success: true, seeded });
    } catch (err) {
        console.error('[airline] seed error', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get("/", async (req, res) => {
  try {
    const rows = await Airlines.find({}).limit(100).lean();
    return res.json({ ok: true, airlines: rows });
  } catch (err) {
    console.error("GET /api/airlines error", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

module.exports = router;
