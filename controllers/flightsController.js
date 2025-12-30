// controllers/flightsController.js
'use strict';

const Flight = require('../models/Flight');
const flightData = require('../services/flightData');

/* ---------------- HELPERS ---------------- */

/** Normalize airport code to 3-letter IATA or return null */
function normalizeAirportCode(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  return null;
}

/** Normalize date to YYYY-MM-DD or return null */
function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return s;
}

/* ---------------- CONTROLLERS ---------------- */

/**
 * GET /api/flights/search?origin=BOM&destination=DEL&date=2025-12-13&limit=20
 * Primary: Amadeus (via adapter)
 * Fallback: Local DB
 */
exports.search = async (req, res) => {
  try {
    const q = { ...(req.query || {}), ...(req.body || {}) };
    let { origin, destination, date, limit } = q;

    origin = normalizeAirportCode(origin);
    destination = normalizeAirportCode(destination);
    date = normalizeDate(date);
    limit = Math.max(1, Math.min(Number(limit || 20) || 20, 100));

    /* ---------------- PROVIDER SEARCH (AMADEUS) ---------------- */

    let providerResult = null;
    try {
      providerResult = await flightData.search({
        origin,
        destination,
        date,
        limit
      });
    } catch (e) {
      console.warn('[flights] provider search threw', e?.message || e);
    }

    if (
      providerResult &&
      providerResult.ok === true &&
      Array.isArray(providerResult.flights)
    ) {
      return res.json(providerResult.flights);
    }

    /* ---------------- FALLBACK: LOCAL DB ---------------- */

    try {
      const dbQuery = {};
      if (origin) dbQuery.origin = origin;
      if (destination) dbQuery.destination = destination;

      const dbRows = await Flight.find(dbQuery)
        .limit(limit)
        .lean();

      if (Array.isArray(dbRows) && dbRows.length > 0) {
        console.warn('[flights] provider unavailable, serving DB fallback');
        return res.json(dbRows);
      }
    } catch (dbErr) {
      console.error('[flights] DB fallback error', dbErr);
    }

    /* ---------------- NOTHING FOUND ---------------- */

    return res.status(503).json({
      ok: false,
      message: 'Flight search temporarily unavailable',
      diagnostic: providerResult?.diagnostic || null
    });

  } catch (err) {
    console.error('[flights] search fatal error', err);
    return res.status(500).json({
      ok: false,
      message: 'server error',
      error: err?.message || String(err)
    });
  }
};

exports.revalidate = async (req, res) => {
  try {
    const { offer } = req.body;

    if (!offer) {
      return res.status(400).json({ ok: false, message: 'offer required' });
    }

    const airlines = require('../services/airlines/adapter');
    const result = await airlines.revalidate({ offer });

    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        message: 'Fare revalidation failed',
        reason: result.reason,
        diagnostic: result.diagnostic
      });
    }

    return res.json({
      ok: true,
      price: result.price,
      raw: result.raw
    });
  } catch (err) {
    console.error('[flights] revalidate error', err);
    return res.status(500).json({ ok: false, message: 'server error' });
  }
};

/**
 * Alias for backward compatibility
 */
exports.list = async (req, res) => {
  return exports.search(req, res);
};

/**
 * GET /api/flights/:id
 * Prefer DB lookup. Provider fetch by ID is not supported by Amadeus sandbox.
 */
exports.getOne = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ message: 'id required' });
    }

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      const flight = await Flight.findById(id).lean();
      if (flight) return res.json(flight);
    }

    return res.status(404).json({
      message: 'Flight not found',
      note: 'Live provider lookup by ID is not supported'
    });

  } catch (err) {
    console.error('[flights] getOne error', err);
    return res.status(500).json({ message: 'server error' });
  }
};
