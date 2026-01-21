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

// function extractTravelDate(req) {
//   return (
//     req.query?.date ||
//     req.body?.date ||
//     req.body?.travelDate ||
//     null
//   );
// }

function extractTravelDate(req) {
  return req.query?.date || req.body?.travelDate || null;
}

async function releaseExpiredHolds(map) {
  const now = new Date();
  let changed = false;

  if (!map || !Array.isArray(map.seats)) return { map, changed };

  map.seats.forEach((s) => {
    if (!s) return;
    if (s.status === 'held' && s.holdUntil) {
      if (new Date(s.holdUntil) <= now) {
        s.status = 'free';
        s.heldBy = null;
        s.holdUntil = null;
        changed = true;
      }
    }
  });

  return { map, changed };
}


// GET seat map
router.get('/:flightId', async (req, res) => {
  try {
    const { flightId } = req.params;
    const travelDate = extractTravelDate(req);
    const { origin, destination } = req.query;

    if (!travelDate) {
      return res.status(400).json({ error: 'travelDate is required' });
    }

    if (!origin || !destination) {
      return res.status(400).json({
        error: 'origin and destination are required'
      });
    }

    // 1️⃣ Try exact seatMap first (instance)
    let map = await SeatMap.findOne({
      flightId: String(flightId),
      travelDate,
      origin,
      destination
    });

    // 2️⃣ If not found → clone from template
    if (!map) {
      const template = await SeatMap.findOne({
        flightId: String(flightId)
      })
        .sort({ updatedAt: -1 })
        .lean();

      if (!template) {
        return res.status(404).json({
          success: false,
          message: `Seat map template not found for flight ${flightId}`
        });
      }

      map = await SeatMap.create({
        // identity
        flightId: template.flightId,

        // route identity (NEW for v3)
        origin,
        destination,
        travelDate,

        // static flight data
        airline: template.airline,
        airlineCode: template.airlineCode,
        departsAt: template.departsAt,

        // layout
        rows: template.rows,
        cols: template.cols,
        layoutMeta: template.layoutMeta,
        aliases: template.aliases,

        // seats (reset state)
        seats: (template.seats || []).map(s => ({
          ...s,
          status: 'free',
          heldBy: null,
          holdUntil: null
        })),

        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // 3️⃣ Cleanup expired holds
    const { map: safeMap } = await releaseExpiredHolds(map);

    return res.json({
      ok: true,
      flightId: safeMap.flightId,
      travelDate: safeMap.travelDate,
      origin: safeMap.origin,
      destination: safeMap.destination,
      rows: safeMap.rows,
      cols: safeMap.cols,
      seats: safeMap.seats,
      layoutMeta: safeMap.layoutMeta
    });

  } catch (err) {
    console.error('[seats.get] error', err);
    return res.status(500).json({ error: 'failed to load seat map' });
  }
});


// POST hold seats (in-place updates; defensive)
// Body: { seats: ["1A","1B"], holdMinutes: 10, heldBy: "user-id-or-ip" }
router.post('/:flightId/hold', async (req, res) => {
  // const { date } = req.query;
  // if (!date) {
  //   return res.status(400).json({ error: 'travelDate is required' });
  // }

  const { flightId } = req.params;
  const payload = req.body || {};
  const seats = Array.isArray(payload.seats) ? payload.seats : [];
  const holdMinutes = Number.isFinite(payload.holdMinutes) ? Number(payload.holdMinutes) : (payload.holdMinutes ? Number(payload.holdMinutes) : 10);
  // prefer explicit body heldBy, else authenticated user, else req.ip
  const heldBy = payload.heldBy || (req.user ? (req.user._id || req.user.id) : null) || req.ip;

  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'seats required' });

  try {
    // find seatmap via flexible keys (flightId could be airline code, _id, etc.)
    // Try to get travelDate from request
    let travelDate = extractTravelDate(req);

    // Find seatMap (date-aware but tolerant)
    // Find seatMap (date-aware but tolerant)
    let map = null;

    // 1️⃣ Try date-specific seatMap
    // 

    if (!travelDate) {
      return res.status(400).json({ error: 'travelDate is required' });
    }

    const origin = req.query?.origin || req.body?.origin || null;
    const destination = req.query?.destination || req.body?.destination || null;

    if (!origin || !destination) {
      return res.status(400).json({
        error: 'origin and destination are required'
      });
    }

    map = await SeatMap.findOne({
      flightId,
      travelDate,
      origin,
      destination
    }).exec();

    if (!map) {
      return res.status(404).json({
        error: 'Seat map not found for selected date'
      });
    }


    if (!map) {
      return res.status(404).json({ error: 'Seat map not found' });
    }

    // derive travelDate if missing
    if (!travelDate && map.travelDate) {
      travelDate = map.travelDate;
    }


    // 🔧 If request did not send travelDate, derive it from seatMap
    if (!travelDate && map.travelDate) {
      travelDate = map.travelDate;
    }


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
    const fresh = await SeatMap.findOne({
      _id: map._id,
      travelDate
    }).exec();

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

router.post('/:flightId/confirm', async (req, res) => {
  return res.status(410).json({
    error: 'DEPRECATED',
    message: 'Seat confirmation is handled via payment flow (SeatMap v2)'
  });
});

// POST release seats (manual)
router.post('/:flightId/release', async (req, res) => {
  const { flightId } = req.params;
  const { seats = [], heldBy } = req.body;
  if (!Array.isArray(seats) || seats.length === 0) return res.status(400).json({ error: 'seats required' });

  try {


    let travelDate = extractTravelDate(req);

    // find seatMap (date-aware but tolerant)
    // Find seatMap (date-aware but tolerant)
    let map = null;



    if (!travelDate) {
      return res.status(400).json({ error: 'travelDate is required' });
    }

    const origin = req.query?.origin || req.body?.origin || null;
    const destination = req.query?.destination || req.body?.destination || null;

    if (!origin || !destination) {
      return res.status(400).json({
        error: 'origin and destination are required'
      });
    }

    map = await SeatMap.findOne({
      flightId,
      travelDate,
      origin,
      destination
    }).exec();

    if (!map) {
      return res.status(404).json({
        error: 'Seat map not found for selected date'
      });
    }


    if (!map) {
      return res.status(404).json({ error: 'Seat map not found' });
    }

    // derive travelDate if missing
    if (!travelDate && map.travelDate) {
      travelDate = map.travelDate;
    }


    // derive travelDate from seatMap if missing
    if (!travelDate && map.travelDate) {
      travelDate = map.travelDate;
    }



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
    const { flightId } = req.params;

    const { date } = req.query;

    const query = {
      $or: [
        { flightId },
        { legacyFlightId: flightId },
        { aliases: flightId },
        { airlineCode: flightId }
      ]
    };

    if (date) {
      query.travelDate = date;
    }

    const map = await SeatMap.findOne(query).exec();


    if (!map) {
      return res.status(404).json({
        ok: false,
        message: 'seatmap not found for this flight and date'
      });
    }

    return res.json({ ok: true, map });

  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
