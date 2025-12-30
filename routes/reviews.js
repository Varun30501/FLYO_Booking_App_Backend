// backend/routes/reviews.js
const express = require('express');
const router = express.Router();
const reviewsCtrl = require('../controllers/reviewsController');

// GET /api/reviews
router.get('/', reviewsCtrl.list);

// POST /api/reviews
router.post('/', reviewsCtrl.create);

module.exports = router;
