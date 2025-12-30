// routes/flightsStatus.js
const express = require('express');
const router = express.Router();
const flightData = require('../services/flightData');
const Flight = require('../models/Flight');

// helper: try multiple ways to find a flight (id | raw.id | meta.offerId)
async function findFlightFlexible(id) {
  if (!id) return null;
  // Try as ObjectId first
  try {
    const byId = await Flight.findById(id).lean();
    if (byId) return byId;
  } catch (e) { /* ignore */ }

  // try fields that some providers use
  const q = {
    $or: [
      { _id: id },
      { id: id },
      { 'raw.id': id },
      { 'meta.offerId': id },
      { flightNumber: id } // last resort
    ]
  };
  return await Flight.findOne(q).lean();
}

router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    console.log('[STATUS ROUTE] requested id =', id);

    const flight = await findFlightFlexible(id);

    const providerHint = flight?.provider || undefined;
    if (flight) console.log('[STATUS ROUTE] found flight provider =', flight.provider);

    // ask adapter for status; pass provider hint if we have one
    const status = await flightData.getStatus(id, 'flight', providerHint);
    console.log('[STATUS ROUTE] adapter returned =', status);

    // fallback to DB-stored status (useful for seeded or mock flights)
    if (!status && flight && flight.status) {
      const dbStatus = {
        code: flight.status.code || 'scheduled',
        text: flight.status.text || 'On time',
        departureAt: flight.departureAt ? flight.departureAt.toISOString() : undefined,
        arrivalAt: flight.arrivalAt ? flight.arrivalAt.toISOString() : undefined,
        seatsAvailable: flight.seatsAvailable
      };
      console.log('[STATUS ROUTE] returning DB fallback status');
      return res.json({ success: true, status: dbStatus });
    }

    if (!status) return res.status(404).json({ success: false, message: 'No status found' });
    return res.json({ success: true, status });
  } catch (err) {
    console.error('[flight-status] error:', err && (err.stack || err));
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
