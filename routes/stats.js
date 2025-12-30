// routes/stats.js
const express = require('express');
const router = express.Router();
const Stats = require('../models/Stats');

// GET /api/stats
router.get('/', async (req, res) => {
  try {
    // Return the single stats document, or defaults
    let stats = await Stats.findOne().lean();
    if (!stats) {
      stats = {
        bookingsToday: 0,
        happyCustomers: 0,
        totalOffers: 0,
        bookingsTrend: [0,0,0,0,0,0,0],
      };
    }
    return res.json(stats);
  } catch (err) {
    console.error('GET /api/stats error', err);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
