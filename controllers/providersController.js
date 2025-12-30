'use strict';

const airlines = (() => {
  try { 
    return require('../services/airlines/adapter'); 
  } catch (e) { 
    return null; 
  }
})();

const ProviderHealth = require('../models/ProviderHealth');

/**
 * GET /api/providers/status
 * Returns provider diagnostics (quick call, non-blocking)
 */
exports.status = async (req, res) => {
  try {
    if (!airlines || typeof airlines.search !== 'function') {
      return res.json({
        ok: false,
        message: 'airlines adapter not available',
        diagnostic: null
      });
    }

    // Lightweight diagnostic probe
    const params = {
      origin: req.query.origin || undefined,
      destination: req.query.destination || undefined,
      date: req.query.date || undefined,
      limit: 1
    };

    const result = await airlines.search(params);

    // 🔹 NEW: Persist provider health snapshot (non-blocking)
    try {
      await ProviderHealth.create({
        provider: 'amadeus',
        ok: !!result.ok,
        diagnostic: result.diagnostic || null
      });
    } catch (logErr) {
      // Never break provider status endpoint
      console.warn('[providers] ProviderHealth log failed:', logErr.message);
    }

    return res.json({
      ok: !!result.ok,
      flightsFound: Array.isArray(result.flights)
        ? result.flights.length
        : 0,
      diagnostic: result.diagnostic || null
    });
  } catch (err) {
    console.error('[providers] status error', err && (err.stack || err));

    // Best-effort failure logging
    try {
      await ProviderHealth.create({
        provider: 'amadeus',
        ok: false,
        diagnostic: { error: err?.message || 'unknown error' }
      });
    } catch (e) {
      console.warn('[providers] ProviderHealth error-log failed:', e.message);
    }

    return res.status(500).json({
      ok: false,
      message: 'server error',
      diagnostic: { error: err && err.message }
    });
  }
};
