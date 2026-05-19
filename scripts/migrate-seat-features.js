/**
 * migrate-seat-features.js
 *
 * One-time migration: backfills features.extraLegroom, exitRow, window, aisle, bulkhead
 * on every seat in every SeatMap document that was seeded without the features field.
 *
 * Usage:
 *   node scripts/migrate-seat-features.js
 *
 * Respects MONGO_URI env var (falls back to localhost).
 */

'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const SeatMap  = require('../models/SeatMap');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flight_booking_dev';

function buildExitRows(rows) {
  const economyStart = 11;
  const economyRows  = Math.max(1, rows - economyStart);
  return new Set([
    economyStart + Math.floor(economyRows * 0.25),
    economyStart + Math.floor(economyRows * 0.65),
  ]);
}

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

(async function main() {
  console.log('Connecting to', MONGO_URI);
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  const all = await SeatMap.find({});
  console.log(`Found ${all.length} seat maps to process.\n`);

  let totalMaps = 0, totalSeats = 0;

  for (const map of all) {
    const cols     = map.cols || 6;
    const rows     = map.rows || 25;
    const exitRows = buildExitRows(rows);

    let changed = false;
    map.seats = map.seats.map(s => {
      if (s.features && s.features.extraLegroom !== undefined) return s; // already has features
      s.features  = backfillFeatures(s, cols, exitRows);
      // also normalise holdUntil → heldUntil alias
      if (s.holdUntil && !s.heldUntil) s.heldUntil = s.holdUntil;
      changed = true;
      totalSeats++;
      return s;
    });

    if (changed) {
      map.updatedAt = new Date();
      await map.save();
      console.log(`  ✓ ${map.flightId} (${map.origin}→${map.destination}) — ${map.seats.length} seats patched`);
      totalMaps++;
    } else {
      console.log(`  – ${map.flightId} (${map.origin}→${map.destination}) — already has features, skipped`);
    }
  }

  console.log(`\nDone. Patched ${totalSeats} seats across ${totalMaps} seat maps.`);
  process.exit(0);
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
