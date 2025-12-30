// routes/flights.js
const express = require('express');
const router = express.Router();
const flightsCtrl = require('../controllers/flightsController');

// Search (query params: origin, destination, date)
router.get('/search', flightsCtrl.search);

// List (legacy)
router.get('/', flightsCtrl.list);

// Get flight by id
router.get('/:id', flightsCtrl.getOne);

router.post('/flights/revalidate', flightsCtrl.revalidate);

module.exports = router;
