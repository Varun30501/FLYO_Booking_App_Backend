// routes/packages.js
const express = require('express');
const router = express.Router();
const Package = require('../models/Package');

// GET /api/packages
router.get('/', async (req, res) => {
  try {
    const list = await Package.find({}).sort({ createdAt: -1 }).limit(100).lean();
    return res.json(list);
  } catch (err) {
    console.error('GET /api/packages error', err);
    return res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

module.exports = router;
