// backend/routes/seats.js
const express = require('express');
const router = express.Router();
const SeatMap = require('../models/SeatMap');
const Booking = require('../models/Booking'); // optional if you create Booking here
const mongoose = require('mongoose');

/**
 * helper: release expired holds in a seatMap document (robust version)
 * - updates in-place where possible
 * - avoids calling toObject() on plain objects
 * - marks seats modified if replaced with plain objects
 */
async function releaseExpiredHolds(map) {
  const now = new Date();
  let changed = false;

  if (!map || !Array.isArray(map.seats)) return map;

  map.seats.forEach((s, idx) => {
    try {
      if (!s) return;
      const status = s.status;
      const holdUntil = s.holdUntil;
      if (status === 'held' && holdUntil) {
        const hu = new Date(holdUntil);
        if (!isNaN(hu.getTime()) && hu <= now) {
          // preserve existing shape, but use safe conversion if subdoc present
          const base = (typeof s.toObject === 'function') ? s.toObject() : { ...s };
          base.status = 'free';
          base.heldBy = null;
          base.holdUntil = null;
          map.seats[idx] = base;
          changed = true;
        }
      }
    } catch (e) {
      // defensive logging — won't break flow
      console.error('[releaseExpiredHolds] skip seat update error', e);
    }
  });

  if (changed) {
    try { map.markModified && map.markModified('seats'); } catch (e) { /* ignore */ }
    map.updatedAt = new Date();
    await map.save();
  }

  return map;
}

// Helpers: robust seatmap lookup by many keys
async function findSeatMapByKey(key) {
  if (!key) return null;

  // 1) direct: flightId
  let map = await SeatMap.findOne({ flightId: key }).exec();
  if (map) return map;

  // 2) legacy flightId
  map = await SeatMap.findOne({ legacyFlightId: key }).exec();
  if (map) return map;

  // 3) aliases
  map = await SeatMap.findOne({ aliases: key }).exec();
  if (map) return map;

  // 4) airlineCode (NEW — IMPORTANT)
  map = await SeatMap.findOne({ airlineCode: key }).exec();
  if (map) return map;

  // 5) numeric airline ID mapping (optional)
  if (/^\d+$/.test(key)) {
    map = await SeatMap.findOne({ airlineNumeric: Number(key) }).exec();
    if (map) return map;
  }

  // 6) _id lookup
  if (mongoose.Types.ObjectId.isValid(key)) {
    map = await SeatMap.findOne({ _id: mongoose.Types.ObjectId(key) }).exec();
    if (map) return map;
  }

  return null;
}

// GET seat map
router.get('/:flightId', async (req, res) => {
  const { flightId } = req.params;
  try {
    // try multiple lookup strategies so seatmaps can be found by different ids/aliases
    const map = await findSeatMapByKey(flightId);
    if (!map) return res.status(404).json({ error: 'Seat map not found' });

    await releaseExpiredHolds(map);

    // return simplified view
    return res.json({
      ok: true,
      flightId: map.flightId,
      rows: map.rows,
      cols: map.cols,
      seats: map.seats,
      layoutMeta: map.layoutMeta
    });
  } catch (err) {
    console.error('[seats GET]', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// POST hold seats (in-place updates; defensive)
// Body: { seats: ["1A","1B"], holdMinutes: 10, heldBy: "user-id-or-ip" }
router.post('/:flightId/hold', async (req, res) => {
  const { flightId } = req.params;
  const payload = req.body || {};
  const seats = Array.isArray(payload.seats) ? payload.seats : [];
  const holdMinutes = Number.isFinite(payload.holdMinutes) ? Number(payload.holdMinutes) : (payload.holdMinutes ? Number(payload.holdMinutes) : 10);
  // prefer explicit body heldBy, else authenticated user, else req.ip
  const heldBy = payload.heldBy || (req.user ? (req.user._id || req.user.id) : null) || req.ip;

  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'seats required' });

  try {
    // find seatmap via flexible keys (flightId could be airline code, _id, etc.)
    const map = await findSeatMapByKey(flightId);
    if (!map) return res.status(404).json({ error: 'Seat map not found' });

    // release expired holds first (defensive)
    await releaseExpiredHolds(map);

    // initial validation: ensure all requested seats exist and are free or held by same heldBy
    for (const seatId of seats) {
      const s = map.seats.find(x => x && x.seatId === seatId);
      if (!s) return res.status(400).json({ error: `invalid seat ${seatId}` });
      if (s.status === 'booked') return res.status(409).json({ error: `seat ${seatId} already booked` });
      if (s.status === 'held' && s.heldBy && s.heldBy !== heldBy) {
        return res.status(409).json({ error: `seat ${seatId} held by someone else` });
      }
    }

    // prepare hold
    const now = new Date();
    const holdUntil = new Date(now.getTime() + Math.max(1, Number(holdMinutes)) * 60 * 1000);

    // --- RACE AVOIDANCE: re-fetch latest doc right before applying changes and re-check statuses ---
    const fresh = await SeatMap.findOne({ _id: map._id }).exec();
    if (!fresh) return res.status(500).json({ error: 'Seat map vanished' });

    // ensure none of the seats are now booked or held by someone else
    for (const seatId of seats) {
      const s = fresh.seats.find(x => x && x.seatId === seatId);
      if (!s) return res.status(400).json({ error: `invalid seat ${seatId}` });
      if (s.status === 'booked') return res.status(409).json({ error: `seat ${seatId} already booked` });
      if (s.status === 'held' && s.heldBy && s.heldBy !== heldBy) {
        return res.status(409).json({ error: `seat ${seatId} held by someone else` });
      }
    }

    // apply holds to fresh doc in-place
    let madeChange = false;
    fresh.seats.forEach((s, idx) => {
      if (!s) return;
      if (seats.includes(s.seatId)) {
        if (typeof s.toObject === 'function') {
          s.status = 'held';
          s.heldBy = heldBy;
          s.holdUntil = holdUntil;
        } else {
          fresh.seats[idx] = { ...s, status: 'held', heldBy, holdUntil };
        }
        madeChange = true;
      }
    });

    if (madeChange) {
      try { fresh.markModified && fresh.markModified('seats'); } catch (e) { /* ignore */ }
      fresh.updatedAt = new Date();
      await fresh.save();
    }

    return res.json({ ok: true, holdUntil, seats });
  } catch (err) {
    console.error('[seats HOLD] uncaught error:', err);
    return res.status(500).json({ error: 'server error', message: err.message });
  }
});

// POST confirm (book) seats - marks seats as booked and optionally creates a Booking
router.post('/:flightId/confirm', async (req, res) => {
  const { flightId } = req.params;
  const { seats = [], heldBy: claimedHeldBy, bookingPayload = {} } = req.body || {};
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'seats required' });

  try {
    // find seat map
    const map = await findSeatMapByKey(flightId);
    if (!map) return res.status(404).json({ error: 'Seat map not found' });

    // in-memory release expired holds (do not persist yet)
    try {
      const now = new Date();
      let changed = false;
      map.seats.forEach((s, idx) => {
        if (!s) return;
        if (s.status === 'held' && s.holdUntil) {
          const hu = new Date(s.holdUntil);
          if (!isNaN(hu.getTime()) && hu <= now) {
            if (typeof s.toObject === 'function') {
              s.status = 'free';
              s.heldBy = null;
              s.holdUntil = null;
            } else {
              map.seats[idx] = { ...s, status: 'free', heldBy: null, holdUntil: null };
            }
            changed = true;
          }
        }
      });
      if (changed) {
        try { map.markModified && map.markModified('seats'); } catch (e) { }
      }
    } catch (e) {
      console.error('[seats CONFIRM] in-memory release failed', e);
    }

    // quick validation before re-check
    for (const seatId of seats) {
      const s = map.seats.find(x => x && x.seatId === seatId);
      if (!s) return res.status(400).json({ error: `invalid seat ${seatId}` });
      if (s.status === 'booked') return res.status(409).json({ error: `seat ${seatId} already booked` });
      if (s.status === 'held' && claimedHeldBy && s.heldBy !== claimedHeldBy) {
        return res.status(409).json({ error: `seat ${seatId} held by someone else` });
      }
    }

    // --- RACE AVOIDANCE: re-fetch fresh doc and re-validate prior to saving ---
    const fresh = await SeatMap.findOne({ _id: map._id }).exec();
    if (!fresh) return res.status(500).json({ error: 'Seat map vanished' });

    // release expired holds on fresh as well
    try {
      const now = new Date();
      fresh.seats.forEach((s, idx) => {
        if (!s) return;
        if (s.status === 'held' && s.holdUntil) {
          const hu = new Date(s.holdUntil);
          if (!isNaN(hu.getTime()) && hu <= now) {
            if (typeof s.toObject === 'function') {
              s.status = 'free';
              s.heldBy = null;
              s.holdUntil = null;
            } else {
              fresh.seats[idx] = { ...s, status: 'free', heldBy: null, holdUntil: null };
            }
          }
        }
      });
    } catch (e) {
      console.error('[seats CONFIRM] fresh release failed', e);
    }

    // final validation - ensure seats are still available or held by claimant
    for (const seatId of seats) {
      const s = fresh.seats.find(x => x && x.seatId === seatId);
      if (!s) return res.status(400).json({ error: `invalid seat ${seatId}` });
      if (s.status === 'booked') return res.status(409).json({ error: `seat ${seatId} already booked` });
      if (s.status === 'held' && claimedHeldBy && s.heldBy !== claimedHeldBy) {
        return res.status(409).json({ error: `seat ${seatId} held by someone else` });
      }
      if (s.status === 'held' && !claimedHeldBy && s.heldBy) {
        // if client didn't supply heldBy but seat is held by other, reject
        return res.status(409).json({ error: `seat ${seatId} currently held by ${s.heldBy}` });
      }
    }

    // mark as booked
    fresh.seats.forEach((s, idx) => {
      if (!s) return;
      if (seats.includes(s.seatId)) {
        if (typeof s.toObject === 'function') {
          s.status = 'booked';
          s.heldBy = null;
          s.holdUntil = null;
        } else {
          fresh.seats[idx] = { ...s, status: 'booked', heldBy: null, holdUntil: null };
        }
      }
    });

    try { fresh.markModified && fresh.markModified('seats'); } catch (e) { }

    fresh.updatedAt = new Date();
    await fresh.save(); // single atomic save on one document

    // Optionally create Booking if Booking model present
    let booking = null;
    if (typeof Booking !== 'undefined') {
      try {
        booking = await Booking.create({
          flightId,
          seats,
          status: 'confirmed',
          createdAt: new Date(),
          ...bookingPayload
        });
      } catch (e) {
        // non-fatal
        console.warn('[seats CONFIRM] booking model create failed', e && e.message);
      }
    }

    return res.json({ ok: true, seats, booking: booking || null });
  } catch (err) {
    console.error('[seats CONFIRM] uncaught', err);
    return res.status(500).json({ error: 'server error', message: err.message });
  }
});

// POST release seats (manual)
router.post('/:flightId/release', async (req, res) => {
  const { flightId } = req.params;
  const { seats = [], heldBy } = req.body;
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'seats required' });

  try {
    const map = await findSeatMapByKey(flightId);
    if (!map) return res.status(404).json({ error: 'Seat map not found' });

    let changed = false;
    map.seats.forEach((s, idx) => {
      if (!s) return;
      if (seats.includes(s.seatId)) {
        // only release if held (and optionally heldBy matches)
        if (s.status === 'held' && (!heldBy || s.heldBy === heldBy || s.heldBy === req.ip)) {
          if (typeof s.toObject === 'function') {
            s.status = 'free';
            s.heldBy = null;
            s.holdUntil = null;
          } else {
            map.seats[idx] = { ...s, status: 'free', heldBy: null, holdUntil: null };
          }
          changed = true;
        }
      }
    });

    if (changed) {
      try { map.markModified && map.markModified('seats'); } catch (e) { /* ignore */ }
      map.updatedAt = new Date();
      await map.save();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[seats RELEASE]', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// DEBUG: inspect seat status for a flight
router.get('/:flightId/debug', async (req, res) => {
  try {
    const SeatMap = require('../models/SeatMap');
    const { flightId } = req.params;

    const map = await SeatMap.findOne({ flightId }).lean();
    if (!map) {
      return res.status(404).json({ ok: false, message: 'seatmap not found' });
    }

    return res.json({
      ok: true,
      flightId,
      seats: map.seats.map(s => ({
        seatId: s.seatId,
        status: s.status,
        heldBy: s.heldBy || null
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
