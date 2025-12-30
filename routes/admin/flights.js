//routes/admin/flights.js
const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const ctrl = require('../../controllers/adminFlightsController');

router.use(adminAuth);

// List all flights (manual + amadeus cached)
router.get('/', ctrl.listFlights);

// Create manual flight
router.post('/', ctrl.createFlight);

// Update manual flight
router.put('/:id', ctrl.updateFlight);

// Toggle active/inactive
router.patch('/:id/toggle', ctrl.toggleFlight);

// Delete manual flight
router.delete('/:id', ctrl.deleteFlight);

module.exports = router;
