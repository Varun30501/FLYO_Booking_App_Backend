// routes/seats.js — with fallback to any matching route template
const express = require('express');
const router  = express.Router();
const SeatMap = require('../models/SeatMap');

function extractTravelDate(req) {
  return req.query?.date || req.body?.travelDate || null;
}

/**
 * Derive exit-row set for a given layout.
 * Exit rows are placed ~25% and ~65% into the Economy section.
 * Economy starts at row 11 (after First 1-2, Business 3-5, PremiumEco 6-10).
 */
function buildExitRowsForRoute(rows) {
  const economyStart = 11;
  const economyRows  = Math.max(1, rows - economyStart);
  return new Set([
    economyStart + Math.floor(economyRows * 0.25),
    economyStart + Math.floor(economyRows * 0.65),
  ]);
}

/**
 * Backfill features for a seat that came from a legacy template without features.
 */
function backfillFeatures(s, cols, exitRows) {
  const row = Number(s.row);
  const col = Number(s.col);
  const isExitRow  = exitRows.has(row);
  const isBulkhead = row === 1 || row === 6 || row === 11;
  const isWindow   = col === 1 || col === cols;
  const isAisle    = col === Math.ceil(cols / 2) || col === Math.ceil(cols / 2) + 1;
  return {
    extraLegroom: isExitRow || isBulkhead,
    exitRow:      isExitRow,
    window:       isWindow,
    aisle:        isAisle,
    bulkhead:     isBulkhead,
  };
}

async function releaseExpiredHolds(map) {
  const now = new Date();
  let changed = false;
  if (!map || !Array.isArray(map.seats)) return { map, changed };
  map.seats.forEach((s) => {
    if (s?.status === 'held' && s.holdUntil && new Date(s.holdUntil) <= now) {
      s.status = 'free'; s.heldBy = null; s.holdUntil = null; changed = true;
    }
  });
  return { map, changed };
}

// GET /:flightId — returns seat map, with 4-tier fallback for DB-seeded flights
router.get('/:flightId', async (req, res) => {
  try {
    const { flightId } = req.params;
    const travelDate   = extractTravelDate(req);
    const { origin, destination } = req.query;

    if (!travelDate)             return res.status(400).json({ error: 'travelDate is required' });
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination are required' });

    // 1️⃣ Exact match: specific flight + date + route
    let map = await SeatMap.findOne({ flightId: String(flightId), travelDate, origin, destination });
    if (map) {
      // Backfill features on existing records that predate the features field
      const needsBackfill = map.seats.some(s => !s.features || s.features.extraLegroom === undefined);
      if (needsBackfill) {
        const exitRowsSet = buildExitRowsForRoute(map.rows || 25);
        map.seats = map.seats.map(s => {
          if (s.features && s.features.extraLegroom !== undefined) return s;
          const f = backfillFeatures(s, map.cols || 6, exitRowsSet);
          s.features = f;
          return s;
        });
        map.updatedAt = new Date();
        await map.save();
      }
      const { map: safe, changed } = await releaseExpiredHolds(map);
      if (changed) { safe.updatedAt = new Date(); await safe.save(); }
      return res.json(buildResponse(safe));
    }

    // 2️⃣ Template for this specific flight (any date)
    let template = await SeatMap.findOne({ flightId: String(flightId) }).sort({ updatedAt: -1 }).lean();

    // 3️⃣ FALLBACK: any template matching this origin+destination pair (ignores flightId)
    //    This makes DB-seeded fallback flights work with the existing 20 seat maps
    if (!template) {
      template = await SeatMap.findOne({ origin, destination }).sort({ updatedAt: -1 }).lean();
    }

    // 4️⃣ LAST RESORT: any seat map at all (generic layout)
    if (!template) {
      template = await SeatMap.findOne({}).sort({ updatedAt: -1 }).lean();
    }

    if (!template) {
      return res.status(404).json({ success: false, message: `No seat map available for ${origin}→${destination}` });
    }

    // Clone template for this specific flight+date+route
    // Backfill features for legacy templates that were seeded without them
    const totalRows = template.rows || 25;
    const totalCols = template.cols || 6;
    const exitRowsSet = buildExitRowsForRoute(totalRows);

    map = await SeatMap.create({
      flightId:    String(flightId),
      origin, destination, travelDate,
      airline:     template.airline    || '',
      airlineCode: template.airlineCode || '',
      departsAt:   template.departsAt  || null,
      rows:        totalRows,
      cols:        totalCols,
      layoutMeta:  template.layoutMeta || {},
      aliases:     template.aliases    || [],
      seats: (template.seats || []).map(s => {
        const features = (s.features && s.features.extraLegroom !== undefined)
          ? s.features
          : backfillFeatures(s, totalCols, exitRowsSet);
        return { ...s, status: 'free', heldBy: null, holdUntil: null, heldUntil: null, features };
      }),
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const { map: safe } = await releaseExpiredHolds(map);
    return res.json(buildResponse(safe));

  } catch (err) {
    console.error('[seats.get] error', err);
    return res.status(500).json({ error: 'failed to load seat map' });
  }
});

function buildResponse(m) {
  return {
    ok: true,
    flightId:    m.flightId,
    travelDate:  m.travelDate,
    origin:      m.origin,
    destination: m.destination,
    rows:        m.rows,
    cols:        m.cols,
    seats:       (m.seats || []).map(s => ({
      seatId:        s.seatId,
      row:           s.row,
      col:           s.col,
      seatClass:     s.seatClass,
      priceModifier: s.priceModifier,
      status:        s.status,
      heldBy:        s.heldBy || null,
      holdUntil:     s.holdUntil || null,
      heldUntil:     s.holdUntil || null, // alias for frontend countdown timer
      features: {
        extraLegroom: !!(s.features?.extraLegroom || s.features?.exitRow),
        exitRow:      !!(s.features?.exitRow),
        window:       !!(s.features?.window),
        aisle:        !!(s.features?.aisle),
        bulkhead:     !!(s.features?.bulkhead),
      },
    })),
    layoutMeta:  m.layoutMeta,
    defaultPrice: m.defaultPrice || m.layoutMeta?.defaultPrice || 0
  };
}

// POST /:flightId/hold
router.post('/:flightId/hold', async (req, res) => {
  const { flightId } = req.params;
  const payload      = req.body || {};
  const seats        = Array.isArray(payload.seats) ? payload.seats : [];
  const holdMinutes  = Number.isFinite(payload.holdMinutes) ? payload.holdMinutes : 10;
  const heldBy       = payload.heldBy || req.user?._id || req.user?.id || req.ip;
  const travelDate   = extractTravelDate(req);
  const origin       = req.query?.origin || req.body?.origin || null;
  const destination  = req.query?.destination || req.body?.destination || null;

  if (!seats.length)           return res.status(400).json({ error: 'seats required' });
  if (!travelDate)             return res.status(400).json({ error: 'travelDate required' });
  if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });

  try {
    // Only ever look up the exact document for this flight + date + route.
    // Falling back to a different date or omitting origin/destination risks finding
    // a template clone or a different route's doc — writing held/booked state there
    // leaves the real document untouched and makes those seats appear free to other users.
    const map = await SeatMap.findOne({
      flightId: String(flightId),
      travelDate,
      origin,
      destination
    });

    if (!map) return res.status(404).json({ error: `Seat map not found for ${flightId} on ${travelDate} (${origin}→${destination})` });

    const { map: clearedMap } = await releaseExpiredHolds(map);
    const holdUntil = new Date(Date.now() + holdMinutes * 60_000);
    const failed = [];
    const held   = [];

    for (const seatId of seats) {
      const seat = clearedMap.seats?.find(s => s.seatId === seatId);
      if (!seat) { failed.push({ seatId, reason: 'not_found' }); continue; }
      if (seat.status !== 'free') { failed.push({ seatId, reason: seat.status }); continue; }
      seat.status    = 'held';
      seat.heldBy    = String(heldBy);
      seat.holdUntil = holdUntil;
      seat.heldUntil = holdUntil; // alias for frontend countdown timer
      held.push(seatId);
    }

    if (held.length === 0) {
      return res.status(409).json({ ok: false, error: 'No seats could be held', failed });
    }

    clearedMap.updatedAt = new Date();
    await clearedMap.save();

    return res.json({ ok: true, held, failed, holdUntil });
  } catch (err) {
    console.error('[seats.hold] error', err);
    return res.status(500).json({ error: 'hold failed' });
  }
});

// POST /:flightId/release
router.post('/:flightId/release', async (req, res) => {
  const { flightId } = req.params;
  const { seats = [], heldBy } = req.body || {};
  const travelDate = extractTravelDate(req);

  try {
    const map = await SeatMap.findOne({
      flightId: String(flightId),
      ...(travelDate ? { travelDate } : {})
    }).sort({ updatedAt: -1 });

    if (!map) return res.status(404).json({ error: 'seat map not found' });

    let released = 0;
    for (const seatId of seats) {
      const seat = map.seats?.find(s => s.seatId === seatId);
      if (!seat) continue;
      if (seat.status === 'held' && (!heldBy || seat.heldBy === String(heldBy))) {
        seat.status = 'free'; seat.heldBy = null; seat.holdUntil = null; released++;
      }
    }
    map.updatedAt = new Date();
    await map.save();
    return res.json({ ok: true, released });
  } catch (err) {
    return res.status(500).json({ error: 'release failed' });
  }
});

module.exports = router;