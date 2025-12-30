const express = require('express');
const router = express.Router();
const Addon = require('../models/Addon');

// GET /api/addons
router.get('/', async (req, res) => {
  try {
    const addons = await Addon.find({ active: true }).lean();
    res.json({ success: true, addons });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
