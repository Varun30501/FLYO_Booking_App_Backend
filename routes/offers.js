// backend/routes/offers.js
const express = require('express');
const router = express.Router();
const offersCtrl = require('../controllers/offersController');

// GET /api/offers
router.get('/', offersCtrl.list);

// POST /api/offers  (admin/seed)
router.post('/', offersCtrl.create);

module.exports = router;
