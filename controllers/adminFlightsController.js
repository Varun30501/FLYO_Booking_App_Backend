// controllers/adminFlightsController.js
const Flight = require('../models/Flight');
const mongoose = require('mongoose');

/**
 * GET /admin/flights
 */
exports.listFlights = async (req, res) => {
  try {
    const flights = await Flight.find({})
      .sort({ createdAt: -1 })
      .lean();

    console.log('[adminFlights] total flights:', flights.length);

    res.json({
      ok: true,
      flights
    });
  } catch (e) {
    console.error('[adminFlights] list error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};


/**
 * POST /admin/flights
 * Create MANUAL flight only
 */
exports.createFlight = async (req, res) => {
  try {
    const {
      airline,
      flightNumber,
      origin,
      destination,
      departureAt,
      arrivalAt,
      price
    } = req.body;

    if (!airline || !flightNumber || !origin || !destination || !departureAt) {
      return res.status(400).json({ ok: false, error: 'Missing fields' });
    }

    const flight = await Flight.create({
      airline,
      flightNumber,
      origin,
      destination,
      departureAt: new Date(departureAt),
      arrivalAt: arrivalAt ? new Date(arrivalAt) : null,
      price,
      provider: 'manual',
      active: true
    });

    res.status(201).json({ ok: true, flight });
  } catch (e) {
    console.error('[adminFlights] create error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};

/**
 * PUT /admin/flights/:id
 */
exports.updateFlight = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ ok: false, error: 'Invalid ID' });

    const flight = await Flight.findById(id);
    if (!flight) return res.status(404).json({ ok: false, error: 'Not found' });

    if (flight.provider !== 'manual') {
      return res.status(403).json({ ok: false, error: 'Cannot edit provider flight' });
    }

    Object.assign(flight, req.body);
    await flight.save();

    res.json({ ok: true, flight });
  } catch (e) {
    console.error('[adminFlights] update error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};

/**
 * PATCH /admin/flights/:id/toggle
 */
exports.toggleFlight = async (req, res) => {
  try {
    const flight = await Flight.findById(req.params.id);
    if (!flight) return res.status(404).json({ ok: false, error: 'Not found' });

    flight.active = !flight.active;
    await flight.save();

    res.json({ ok: true, active: flight.active });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server error' });
  }
};

/**
 * DELETE /admin/flights/:id
 */
exports.deleteFlight = async (req, res) => {
  try {
    const flight = await Flight.findById(req.params.id);
    if (!flight) return res.status(404).json({ ok: false, error: 'Not found' });

    if (flight.provider !== 'manual') {
      return res.status(403).json({ ok: false, error: 'Cannot delete provider flight' });
    }

    await flight.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server error' });
  }
};
