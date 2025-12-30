// services/seats.js
'use strict';

const SeatMap = require('../models/SeatMap'); // adjust path if needed
const Booking = require('../models/Booking'); // used only for optional sanity checks

/**
 * restoreSeatsForBooking(bookingOrBookingId, options)
 *
 * - bookingOrBookingId : booking document OR booking id/string (will attempt to fetch)
 * - options: { flightIdOverride, matchFields: ['seatId','seat','label'] }
 *
 * Returns: { ok: true/false, message, restored: <number>, details: { restoredSeats: [...], notFoundSeats: [...] } }
 */
async function restoreSeatsForBooking(bookingOrBookingId, options = {}) {
  try {
    let booking = null;
    if (!bookingOrBookingId) return { ok: false, message: 'no-booking' };

    if (typeof bookingOrBookingId === 'string' || bookingOrBookingId instanceof String) {
      // try to load booking by id/ref
      try {
        booking = await Booking.findById(bookingOrBookingId).lean().catch(() => null);
        if (!booking) booking = await Booking.findOne({ bookingRef: bookingOrBookingId }).lean().catch(() => null);
      } catch (e) {
        booking = null;
      }
    } else if (typeof bookingOrBookingId === 'object') {
      booking = bookingOrBookingId;
    }

    if (!booking) return { ok: false, message: 'booking-not-found' };

    const flightId = options.flightIdOverride || booking.flightId || booking.flight_id;
    if (!flightId) return { ok: false, message: 'no-flightId' };

    // build candidate seat identifiers from booking.seats and seatsMeta
    const seatIds = new Set();
    try {
      if (Array.isArray(booking.seats)) {
        booking.seats.forEach(s => {
          if (!s) return;
          if (typeof s === 'string' || typeof s === 'number') seatIds.add(String(s).trim());
          else if (typeof s === 'object') {
            const v = String(s.seatId || s.label || s.seat || s.id || s.name || '').trim();
            if (v) seatIds.add(v);
          }
        });
      }
      if (Array.isArray(booking.seatsMeta)) {
        booking.seatsMeta.forEach(s => {
          if (!s) return;
          const v = String(s.seatId || s.seat || s.label || '').trim();
          if (v) seatIds.add(v);
        });
      }
    } catch (e) {
      // ignore
    }

    if (!seatIds.size) return { ok: false, message: 'no-seat-ids-in-booking' };

    const seatIdArray = Array.from(seatIds);

    // load seatMap for flight
    const seatMap = await SeatMap.findOne({ flightId }).exec();
    if (!seatMap) return { ok: false, message: 'seatmap-not-found', flightId };

    // mutate in-memory and save — simpler and robust than complex arrayFilters update
    let restoredSeats = [];
    let notFoundSeats = [];
    let changed = 0;

    const normalize = (x) => (x === null || x === undefined) ? '' : String(x).trim();

    const seatMapSeats = Array.isArray(seatMap.seats) ? seatMap.seats : [];

    // Create a lookup from normalized seatId -> seat object index for faster matching
    const lookup = {};
    seatMapSeats.forEach((s, idx) => {
      const keys = [
        normalize(s.seatId),
        normalize(s.seat),
        normalize(s.label),
        normalize(s.id)
      ].filter(Boolean);
      keys.forEach(k => {
        if (!lookup[k]) lookup[k] = [];
        lookup[k].push({ idx, seat: s });
      });
    });

    for (const sid of seatIdArray) {
      const n = normalize(sid);
      if (!n) continue;

      const matches = lookup[n] || [];
      if (!matches.length) {
        // attempt case-insensitive fuzzy match
        const cs = Object.keys(lookup).find(k => k && k.toLowerCase() === n.toLowerCase());
        if (cs) {
          // use first match
          const m = lookup[cs][0];
          if (m && m.idx != null) {
            const seatObj = seatMapSeats[m.idx];
            if (seatObj.status && (seatObj.status === 'booked' || seatObj.status === 'held')) {
              seatObj.status = 'free';
              seatObj.heldBy = null;
              seatObj.holdUntil = null;
              changed++;
              restoredSeats.push(n);
            } else {
              // already free
            }
            continue;
          }
        }
        notFoundSeats.push(n);
        continue;
      }

      // If multiple matches, prefer any that are booked/held
      let applied = false;
      for (const mm of matches) {
        const obj = seatMapSeats[mm.idx];
        if (!obj) continue;
        const prev = String(obj.status || '').toLowerCase();
        if (prev === 'booked' || prev === 'held') {
          obj.status = 'free';
          obj.heldBy = null;
          obj.holdUntil = null;
          changed++;
          restoredSeats.push(n);
          applied = true;
          break;
        }
      }

      if (!applied && matches.length) {
        // nothing was booked — still mark first match as free if not already
        const obj = seatMapSeats[matches[0].idx];
        if (obj && String(obj.status || '').toLowerCase() !== 'free') {
          obj.status = 'free';
          obj.heldBy = null;
          obj.holdUntil = null;
          changed++;
          restoredSeats.push(n);
        } else {
          // already free - consider as restored=false but not an error
          restoredSeats.push(n);
        }
      }
    }

    if (changed > 0) {
      seatMap.seats = seatMapSeats;
      seatMap.updatedAt = new Date();
      await seatMap.save();
    }

    return { ok: true, message: 'restore-complete', restored: changed, details: { restoredSeats, notFoundSeats } };
  } catch (err) {
    console.error('[seats.restoreSeatsForBooking] fatal', err && (err.stack || err));
    return { ok: false, message: 'restore-failed', error: err && (err.message || String(err)) };
  }
}

module.exports = { restoreSeatsForBooking };
