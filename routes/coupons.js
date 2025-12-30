// backend/routes/coupons.js
const express = require('express');
const router = express.Router();

let Coupon;
try {
  Coupon = require('../models/Coupon');
} catch (e) {
  Coupon = null;
  console.error('[coupons] model load error:', e && (e.stack || e.message || e));
}

/** Safe boolean parser */
function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return undefined;
}

/**
 * GET /api/coupons
 */
router.get('/', async (req, res) => {
  try {
    if (!Coupon) {
      return res.status(500).json({ success: false, message: 'Coupon model not available (see server logs)' });
    }

    const q = {};

    // Protect against req.query being null, undefined, or a prototype-less object
    const hasQuery = !!req.query && typeof req.query === 'object';

    if (hasQuery && typeof req.query.active !== 'undefined') {
      const b = parseBool(req.query.active);
      if (typeof b === 'boolean') q.active = b;
    }

    if (hasQuery && req.query.code) {
      q.code = String(req.query.code || '').toUpperCase().trim();
    }

    // default to only active coupons unless caller explicitly provided active param or code
    const explicitlyProvidedActive = hasQuery && Object.prototype.hasOwnProperty.call(req.query, 'active');
    const providedCode = hasQuery && typeof req.query.code !== 'undefined' && req.query.code !== null && String(req.query.code || '').trim() !== '';

    if (!explicitlyProvidedActive && !providedCode) q.active = true;

    const projection = { __v: 0 }; // avoid exposing mongoose internals
    const rows = await Coupon.find(q, projection).sort({ createdAt: -1 }).lean().exec();
    return res.json({ success: true, coupons: rows });
  } catch (err) {
    console.error('[coupons] list error:', err && (err.stack || err.message || err));
    const isDev = (process.env.NODE_ENV || '').toLowerCase() !== 'production';
    return res.status(500).json({
      success: false,
      message: 'server error listing coupons',
      error: isDev ? (err && (err.stack || err.message)) : undefined
    });
  }
});

/**
 * DEBUG route: GET /api/coupons/debug
 */
router.get('/debug', async (req, res) => {
  try {
    if (!Coupon) {
      return res.status(500).json({ success: false, ok: false, message: 'Coupon model not loaded' });
    }
    const count = await Coupon.countDocuments({}).exec();
    const sample = await Coupon.findOne({}).lean().exec();
    return res.json({ success: true, ok: true, count, sample });
  } catch (err) {
    console.error('[coupons] debug error:', err && (err.stack || err.message || err));
    const isDev = (process.env.NODE_ENV || '').toLowerCase() !== 'production';
    return res.status(500).json({ success: false, ok: false, message: 'debug failed', error: isDev ? (err && (err.stack || err.message)) : undefined });
  }
});

module.exports = router;
