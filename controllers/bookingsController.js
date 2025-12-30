// controllers/bookingsController.js
const Booking = require('../models/Booking');
const Idempotency = (() => { try { return require('../models/Idempotency'); } catch (e) { return null; } })();
const flightData = (() => { try { return require('../services/flightData'); } catch (e) { return null; } })();
const airlines = (() => { try { return require('../services/airlines/adapter'); } catch (e) { return null; } })();
const { v4: uuidv4 } = require('uuid');
const paymentsCtrl = require('../controllers/paymentsController');
const SeatMap = (() => { try { return require('../models/SeatMap'); } catch (e) { return null; } })();
const pdfUtils = (() => { try { return require('../utils/pdf'); } catch (e) { return null; } })();
const seatsService = (() => { try { return require('../services/seats'); } catch (e) { return null; } })();


const crypto = require('crypto');
const mongoose = require('mongoose');

// optional emailer (may export generateItineraryPDF & sendBookingConfirmation)
const emailer = (() => {
  try { return require('../utils/emailer'); } catch (e) { return null; }
})();

/** Generate booking reference */
function generateBookingRef() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
}

/** Safe date parsing for common formats (dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd) */
function parseDateLoose(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  const s = String(v).trim();
  if (!s) return null;
  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isoMatch) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const dm = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dm) {
    const dd = Number(dm[1]), mm = Number(dm[2]), yyyy = Number(dm[3]);
    const d = new Date(yyyy, mm - 1, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

/** Normalize seats sent from frontend into canonical simple objects { seatId } */
function normalizeSeats(seats) {
  if (!Array.isArray(seats)) return [];
  const out = [];
  for (const s of seats) {
    if (!s && s !== 0) continue;
    if (typeof s === 'string' || typeof s === 'number') {
      out.push({ seatId: String(s) });
    } else if (typeof s === 'object') {
      const seatId = s.seatId || s.label || s.id || s.name || s.seat || null;
      if (seatId) out.push({ seatId: String(seatId) });
    }
  }
  return out;
}

/** Convert human-readable amount to smallest currency unit for Stripe.
 *  Assumes `amt` is in major currency units (e.g. rupees).
 */
function toStripeAmount(amt, currency = 'INR') {
  const n = Number(amt) || 0;
  const c = (currency || 'INR').toLowerCase();
  const zeroDecimalCurrencies = new Set(['jpy']);
  const multiplier = zeroDecimalCurrencies.has(c) ? 1 : 100;
  return Math.round(n * multiplier);
}

/** Helper: compute per-seat price server-side (kept similar to prior behavior)
 *  (NOTE: retained as a utility but server will not rely on it for final pricing if seatsMeta provided)
 */
function computeSeatPriceForServer(seatObj = {}, baseFareMajor = 0) {
  try {
    const seat = seatObj || {};

    const sclassRaw = String(seat.seatClass || seat.class || seat.category || '').toLowerCase().replace(/\s+/g, '');
    const seatClass = (sclassRaw === 'first' || sclassRaw === 'firstclass' || sclassRaw === 'first_class') ? 'first'
      : (sclassRaw === 'business' || sclassRaw === 'businessclass' || sclassRaw === 'business_class') ? 'business'
        : (sclassRaw === 'premiumeconomy' || sclassRaw === 'premium_economy' || sclassRaw === 'premium' || sclassRaw === 'premeco' || sclassRaw === 'premiumeco') ? 'premium'
          : 'economy';

    const forceAbsolute = !!(seat.absolute === true || seat.forceAbsolute === true || seat.isAbsolute === true);

    const absCandidates = [seat.price, seat.absolutePrice, seat.priceAbsolute, seat.absolute, seat.amount];
    const findAbsolute = () => {
      for (const c of absCandidates) {
        if (typeof c === 'number' && !Number.isNaN(c)) return Number(c);
        if (typeof c === 'string' && c.trim() !== '') {
          const n = Number(String(c).replace(/[^\d.-]/g, ''));
          if (!Number.isNaN(n)) return n;
        }
      }
      return null;
    };
    const absoluteVal = findAbsolute();

    const priceModifier = (typeof seat.priceModifier === 'number') ? Number(seat.priceModifier)
      : (seat.priceModifier ? Number(seat.priceModifier) : 0);

    if (forceAbsolute && absoluteVal !== null) {
      return Number(absoluteVal);
    }

    const base = (typeof baseFareMajor === 'number' && !Number.isNaN(baseFareMajor) && Number(baseFareMajor) > 0) ? Number(baseFareMajor) : null;

    if (seatClass === 'economy') {
      if (base !== null) return Number(base);
      if (absoluteVal !== null) return Number(absoluteVal);
      return Number(priceModifier || 0);
    }

    if (seatClass !== 'economy') {
      if (base !== null) {
        return Number(base) + Number(priceModifier || 0);
      }
      if (absoluteVal !== null) return Number(absoluteVal);
      return Number(priceModifier || 0);
    }

    if (absoluteVal !== null) return Number(absoluteVal);
    return Number(priceModifier || 0);
  } catch (e) {
    try {
      if (seatObj && typeof seatObj.price === 'number') return Number(seatObj.price);
      if (seatObj && typeof seatObj.priceModifier === 'number') return Number(seatObj.priceModifier);
    } catch (ee) { /* ignore */ }
    return 0;
  }
}

/** BAREBONES function to attempt to validate coupon.
 *  Strategy:
 *   - If a `models/Coupon` exists, use it to validate (expiry, minFare, usage, allowedAirlines).
 *   - Else, if coupon object contains validation fields (validFrom/validTo/minFare/etc), validate against those.
 *   - If nothing to validate against, we accept coupon but mark validated: false, reason: 'no-server-check'
 *
 *  Returns normalized coupon object to be persisted:
 *   { code, amount, percent, validated, reason, metadata, appliesTo, appliedAt, cap }
 */
async function validateAndNormalizeCoupon(inputCoupon = {}, userId = null, context = {}) {
  // inputCoupon may be string code or object
  try {
    const CouponModel = (() => { try { return require('../models/Coupon'); } catch (e) { return null; } })();

    const now = new Date();
    let code = '';
    let amount = 0;
    let percent = 0;
    let cap = 0;
    let metadata = null;
    let validated = false;
    let reason = '';
    let appliesTo = null;

    if (!inputCoupon) {
      return { code: '', amount: 0, percent: 0, cap: 0, validated: false, reason: 'empty' };
    }

    if (typeof inputCoupon === 'string') {
      code = inputCoupon.trim().toUpperCase();
    } else if (typeof inputCoupon === 'object') {
      code = (inputCoupon.code || inputCoupon.coupon || '').toString().trim().toUpperCase();
      amount = Math.abs(Number(inputCoupon.amount ?? inputCoupon.discount ?? 0) || 0);
      percent = Math.abs(Number(inputCoupon.percent ?? inputCoupon.percentage ?? 0) || 0);
      cap = Math.abs(Number(inputCoupon.cap ?? 0) || 0);
      metadata = inputCoupon.metadata || inputCoupon.meta || null;
      appliesTo = inputCoupon.appliesTo || null;
    }

    if (!code) return { code, amount, percent, cap, validated: false, reason: 'no-code' };

    // If CouponModel exists, try to find and validate rules
    if (CouponModel) {
      try {
        const dbCoupon = await CouponModel.findOne({ code }).lean();
        if (!dbCoupon) {
          return { code, amount, percent, cap, validated: false, reason: 'not-found' };
        }

        // Reject inactive coupons
        if (dbCoupon.active === false) {
          return { code, amount, percent, cap: dbCoupon.cap || 0, validated: false, reason: 'inactive', metadata: dbCoupon.metadata || dbCoupon };
        }

        // copy canonical fields
        metadata = dbCoupon.metadata || dbCoupon.meta || dbCoupon;
        appliesTo = dbCoupon.appliesTo || dbCoupon.applies || appliesTo || null;

        // amount/percent/cap as in db override
        if (typeof dbCoupon.amount === 'number') amount = Math.abs(Number(dbCoupon.amount || 0));
        if (typeof dbCoupon.percent === 'number') percent = Math.abs(Number(dbCoupon.percent || 0));
        if (typeof dbCoupon.cap === 'number') cap = Math.abs(Number(dbCoupon.cap || 0));

        // check expiry
        if (dbCoupon.validFrom && new Date(dbCoupon.validFrom) > now) return { code, amount, percent, cap, validated: false, reason: 'not-started', metadata };
        if (dbCoupon.validTo && new Date(dbCoupon.validTo) < now) return { code, amount, percent, cap, validated: false, reason: 'expired', metadata };

        // min fare
        if (dbCoupon.minFare && typeof dbCoupon.minFare === 'number') {
          const fare = Number(context.fare || 0);
          if (fare < Number(dbCoupon.minFare)) return { code, amount, percent, cap, validated: false, reason: 'min-fare-not-met', metadata };
        }

        // airline / route restrictions (if set)
        if (dbCoupon.allowedAirlines && Array.isArray(dbCoupon.allowedAirlines) && dbCoupon.allowedAirlines.length) {
          const flight = context.flight || null;
          const flightProvider = (flight && (flight.airlineCode || flight.code || flight.provider)) || null;
          if (flightProvider && !dbCoupon.allowedAirlines.map(x => String(x).toUpperCase()).includes(String(flightProvider).toUpperCase())) {
            return { code, amount, percent, cap, validated: false, reason: 'airline-mismatch', metadata };
          }
        }

        // usageLimit and perUserLimit
        if (Number.isFinite(Number(dbCoupon.usageLimit)) && dbCoupon.usageLimit > 0) {
          if (typeof dbCoupon.usedCount === 'number' && dbCoupon.usedCount >= dbCoupon.usageLimit) {
            return { code, amount, percent, cap, validated: false, reason: 'usage-limit-reached', metadata };
          }
        }
        if (Number.isFinite(Number(dbCoupon.perUserLimit)) && dbCoupon.perUserLimit > 0 && userId) {
          // Attempt to count user's usage — best-effort: if CouponModel tracks usage by user, check; else query bookings
          try {
            if (dbCoupon.usageByUser && typeof dbCoupon.usageByUser === 'object') {
              const used = dbCoupon.usageByUser[String(userId)] || 0;
              if (used >= dbCoupon.perUserLimit) return { code, amount, percent, cap, validated: false, reason: 'per-user-limit', metadata };
            } else {
              // fallback: count bookings with this coupon code by the user
              const usedCount = await Booking.countDocuments({ userId: String(userId), 'coupons.code': code }).lean();
              if (usedCount >= dbCoupon.perUserLimit) return { code, amount, percent, cap, validated: false, reason: 'per-user-limit', metadata };
            }
          } catch (e) {
            // ignore counting errors and proceed
          }
        }

        // All checks passed
        validated = true;
        reason = 'ok';

        return {
          code,
          amount: Math.round(Number(amount || 0)),
          percent: Math.round(Number(percent || 0)),
          cap: Math.round(Number(cap || 0)),
          validated,
          reason,
          metadata,
          appliesTo,
          appliedAt: now
        };
      } catch (e) {
        // coupon model query failed -> fallback behavior below
        // keep going to fallback checks
      }
    }

    // Fallback validation: check input fields if they provide time windows or minFare
    if (metadata && typeof metadata === 'object') {
      if (metadata.validFrom && new Date(metadata.validFrom) > now) return { code, amount, percent, cap, validated: false, reason: 'not-started', metadata };
      if (metadata.validTo && new Date(metadata.validTo) < now) return { code, amount, percent, cap, validated: false, reason: 'expired', metadata };
      if (typeof metadata.minFare === 'number' && context.fare && Number(context.fare) < Number(metadata.minFare)) return { code, amount, percent, cap, validated: false, reason: 'min-fare-not-met', metadata };
    }

    // If input included explicit amount/percent we accept but mark validated=false (no server check)
    return {
      code,
      amount: Math.round(Number(amount || 0)),
      percent: Math.round(Number(percent || 0)),
      cap: Math.round(Number(cap || 0)),
      validated: false,
      reason: 'no-server-check',
      metadata,
      appliesTo,
      appliedAt: now
    };
  } catch (err) {
    return { code: '', amount: 0, percent: 0, cap: 0, validated: false, reason: 'validation-error' };
  }
}

/**
 * computeDiscountFromCoupons
 * - couponsNormalized: array returned from validateAndNormalizeCoupon (with validated, amount, percent, cap)
 * - baseAmount: seatsSubtotal + addonsTotal - preExistingDiscounts
 * Returns numeric discountsTotal (major units) and per-coupon breakdown.
 *
 * Applies per-coupon cap for percent-based discounts.
 */
function computeDiscountFromCoupons(couponsNormalized = [], baseAmount = 0) {
  let discountsTotal = 0;
  const breakdown = [];

  for (const c of couponsNormalized) {
    if (!c) continue;
    let line = 0;
    if (Number.isFinite(Number(c.amount)) && Number(c.amount) > 0) {
      // amount is absolute discount
      line = Math.round(Number(c.amount));
    } else if (Number.isFinite(Number(c.percent)) && Number(c.percent) > 0) {
      // percent discount of baseAmount
      const raw = Math.round((Number(c.percent) / 100) * Math.round(baseAmount || 0));
      // apply cap if present and > 0
      if (Number.isFinite(Number(c.cap)) && Number(c.cap) > 0) {
        line = Math.min(raw, Math.round(Number(c.cap)));
      } else {
        line = raw;
      }
    } else {
      line = 0;
    }

    // include computed line regardless; applied flag indicates server validation result
    discountsTotal += line;
    breakdown.push({
      code: c.code || '',
      applied: c.validated === true,
      amount: line,
      percent: c.percent || 0,
      cap: c.cap || 0,
      reason: c.reason || ''
    });
  }

  return { discountsTotal: Math.round(discountsTotal || 0), breakdown };
}

async function restoreSeatsForBooking(booking) {
  try {
    const SeatMap = require('../models/SeatMap');
    if (!SeatMap) {
      return { ok: false, reason: 'SeatMap model missing' };
    }

    if (!booking || !booking.flightId) {
      return { ok: false, reason: 'missing booking or flightId' };
    }

    // 1️⃣ Collect ALL possible seat identifiers
    const seatIds = new Set();

    if (Array.isArray(booking.seats)) {
      booking.seats.forEach(s => {
        if (!s) return;
        if (typeof s === 'string') seatIds.add(String(s));
        else if (s.label) seatIds.add(String(s.label));
        else if (s.seatId) seatIds.add(String(s.seatId));
      });
    }

    if (Array.isArray(booking.seatsMeta)) {
      booking.seatsMeta.forEach(s => {
        if (s?.seatId) seatIds.add(String(s.seatId));
      });
    }

    const seatIdArray = [...seatIds].filter(Boolean);

    if (!seatIdArray.length) {
      return { ok: false, reason: 'no seatIds extracted' };
    }

    // 2️⃣ Find seatmap defensively (Amadeus mismatch safe)
    const map = await SeatMap.findOne({
      $or: [
        { flightId: booking.flightId },
        { legacyFlightId: booking.flightId },
        { aliases: booking.flightId }
      ]
    });

    if (!map) {
      return { ok: false, reason: 'seatmap not found for flightId', flightId: booking.flightId };
    }

    // 3️⃣ Restore seats IN-MEMORY (most reliable)
    let restored = 0;

    map.seats.forEach(seat => {
      if (!seat) return;

      const match =
        seatIds.has(String(seat.seatId)) ||
        (seat.label && seatIds.has(String(seat.label)));

      if (match && seat.status === 'booked') {
        seat.status = 'free';
        seat.heldBy = null;
        seat.holdUntil = null;
        restored++;
      }
    });

    if (restored === 0) {
      return {
        ok: false,
        reason: 'no seats matched for restore',
        seatIds: seatIdArray,
        flightId: booking.flightId
      };
    }

    map.markModified('seats');
    map.updatedAt = new Date();
    await map.save();

    return {
      ok: true,
      restoredSeats: seatIdArray,
      restoredCount: restored,
      seatMapId: map._id
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'restore failed',
      error: err.message
    };
  }
}





async function sendCancellationEmail(booking, { cancellationFeeMajor = 0, refundMajor = 0, refundRaw = null } = {}) {
  try {
    const emailerLocal = (() => { try { return require('../utils/emailer'); } catch (e) { return null; } })();
    if (!emailerLocal) return false;
    const b = booking && booking.toObject ? booking.toObject() : (booking || {});
    const to = b.contact && (b.contact.email || b.contact.emailAddress) ? b.contact.email || b.contact.emailAddress : null;
    const bookingRef = b.bookingRef || (b._id && String(b._id)) || '—';
    const currency = (b.price && b.price.currency) ? b.price.currency : 'INR';

    const textLines = [
      `Your booking ${bookingRef} has been cancelled.`,
      ``,
      `Cancellation fee: ${currency} ${cancellationFeeMajor}`,
      `Refund amount: ${currency} ${refundMajor}`,
      ``,
      `If you have questions, reply to this email.`
    ];
    const text = textLines.join('\n');

    // generate cancellation invoice PDF
    let pdfBuffer = null;
    try {
      if (pdfUtils && typeof pdfUtils.generateCancellationInvoicePDF === 'function') {
        pdfBuffer = await pdfUtils.generateCancellationInvoicePDF(b, { cancellationFeeMajor, refundMajor, refundRaw });
      }
    } catch (e) {
      console.warn('[bookings.cancel] generateCancellationInvoicePDF failed (non-fatal)', e && e.message);
      pdfBuffer = null;
    }

    const subject = `Booking Cancelled — ${bookingRef}`;
    const attachments = [];
    if (pdfBuffer && Buffer.isBuffer(pdfBuffer)) {
      attachments.push({
        filename: `${bookingRef}-invoice.pdf`,
        content: pdfBuffer,
        type: 'application/pdf'
      });
    }

    const htmlBody = `<div><p>Your booking <strong>${bookingRef}</strong> has been cancelled.</p>
           <p><strong>Cancellation fee:</strong> ${currency} ${cancellationFeeMajor} <br/>
           <strong>Refund amount:</strong> ${currency} ${refundMajor}</p>
           <p>If you have questions, reply to this email.</p>
           </div>`;

    const mailResult = await emailerLocal.sendMail({
      to,
      subject,
      text,
      html: htmlBody,
      attachments
    }).catch(e => { throw e; });

    return !!mailResult;
  } catch (e) {
    console.warn('[bookings.cancel] sendCancellationEmail error', e && (e.message || e));
    return false;
  }
}
/**
 * POST /api/bookings
 * Pricing mode: FRONTEND-authoritative (Option A)
 * - Backend validates incoming price hints (price.amount, price.perSeat, price.tax),
 * - Backend sanitizes addons/coupons and computes totals from sanitized inputs,
 * - Backend stores canonical seatsMeta (either provided or computed minimally),
 * - Backend persists addon & coupon normalized objects (with validation flags).
 */
exports.create = async (req, res) => {
  try {
    const idempotencyKey = req.header('Idempotency-Key') || req.body.idempotencyKey || null;

    // Idempotency short-circuit
    if (idempotencyKey && Idempotency) {
      try {
        const map = await Idempotency.findOne({ key: idempotencyKey }).lean();
        if (map && map.bookingId) {
          const existing = await Booking.findById(map.bookingId).lean();
          if (existing) return res.status(200).json({ success: true, booking: existing, idempotent: true });
        }
      } catch (e) {
        console.warn('[bookings] idempotency lookup failed', e && e.message);
      }
    }

    const {
      flightId,
      passengers = [],
      contact = {},
      userId: bodyUserId,
      price,
      createSession = false,
      metadata = {},
      seats = [],
      seatsMeta = [],
      addons = [],
      coupons = [],
      discounts = []
    } = req.body || {};

    if (!flightId) return res.status(400).json({ success: false, message: 'flightId required' });

    const authUserId = req.userId || (req.user && (req.user._id || req.user.id)) || null;
    const finalUserId = authUserId || bodyUserId || null;
    if (!finalUserId) console.warn('[bookings] create: guest booking (no userId).');

    // Normalize seats and passengers
    const normalizedSeats = normalizeSeats(seats || []);
    if (!Array.isArray(normalizedSeats) || normalizedSeats.length === 0) {
      return res.status(400).json({ success: false, message: 'seats required for booking' });
    }

    const normalizedPassengers = (Array.isArray(passengers) ? passengers : []).map(p => {
      const copy = { ...(p || {}) };
      if (copy.dob) {
        const parsed = parseDateLoose(copy.dob);
        if (parsed) copy.dob = parsed;
        else delete copy.dob;
      }
      return copy;
    });

    // Try to get seat map if present (for validation)
    let SeatMapModel = null;
    try { SeatMapModel = require('../models/SeatMap'); } catch (e) { SeatMapModel = null; }

    let map = null;
    if (SeatMapModel) {
      try {
        map = await SeatMapModel.findOne({ flightId }).exec();
        if (!map) map = await SeatMapModel.findOne({ legacyFlightId: flightId }).exec();
        if (!map) map = await SeatMapModel.findOne({ aliases: flightId }).exec();
        if (!map && mongoose.Types.ObjectId.isValid(flightId)) map = await SeatMapModel.findById(mongoose.Types.ObjectId(flightId)).exec();
      } catch (e) {
        console.warn('[bookings] seatmap lookup error', e && e.message);
      }
      if (!map && SeatMapModel) {
        // If seatmap model exists but no map found, treat as error (defensive)
        return res.status(404).json({ success: false, message: 'Seat map not found for flightId' });
      }
    }

    // If seatmap present — validate requested seats exist & not booked/held (best effort)
    if (map) {
      try {
        const now = new Date();
        // release expired holds in memory
        map.seats.forEach((s, idx) => {
          if (!s) return;
          if (s.status === 'held' && s.holdUntil) {
            const hu = new Date(s.holdUntil);
            if (!isNaN(hu.getTime()) && hu <= now) {
              if (typeof s.toObject === 'function') {
                s.status = 'free'; s.heldBy = null; s.holdUntil = null;
              } else {
                map.seats[idx] = { ...s, status: 'free', heldBy: null, holdUntil: null };
              }
            }
          }
        });
      } catch (e) {
        console.warn('[bookings] release expired holds failed', e && e.message);
      }

      for (const seatObj of normalizedSeats) {
        const seatId = seatObj.seatId;
        const s = map.seats.find(x => x && (String(x.seatId) === String(seatId) || String(x.label) === String(seatId) || String(x.id) === String(seatId)));
        if (!s) return res.status(400).json({ success: false, message: `invalid seat ${seatId}` });
        if (s.status === 'booked') return res.status(409).json({ success: false, message: `seat ${seatId} already booked` });
        const requester = req.userId || req.ip || null;
        if (s.status === 'held' && s.heldBy && s.heldBy !== requester && s.heldBy !== (req.body.heldBy || null)) {
          return res.status(409).json({ success: false, message: `seat ${seatId} held by someone else` });
        }
      }

      // mark as booked in seatmap (in-place)
      map.seats.forEach((s, idx) => {
        if (!s) return;
        const match = normalizedSeats.some(ns => String(ns.seatId) === String(s.seatId) || String(ns.seatId) === String(s.label) || String(ns.seatId) === String(s.id));
        if (match) {
          if (typeof s.toObject === 'function') {
            s.status = 'booked'; s.heldBy = null; s.holdUntil = null;
          } else {
            map.seats[idx] = { ...s, status: 'booked', heldBy: null, holdUntil: null };
          }
        }
      });

      try {
        if (map.markModified) map.markModified('seats');
        map.updatedAt = new Date();
        await map.save();
      } catch (e) {
        console.error('[bookings] failed to persist seatmap changes', e && e.message);
        return res.status(500).json({ success: false, message: 'Failed to persist seat reservation' });
      }
    } else {
      console.warn('[bookings] SeatMap model not found — proceeding without seat confirmation (unsafe)');
    }

    // resolve flight meta if available
    let flight = null;
    if (flightData && typeof flightData.getFlight === 'function') {
      try { flight = await flightData.getFlight(flightId); } catch (e) { flight = null; }
    }

    // FRONTEND-authoritative pricing -> trust frontend hints but sanitize
    // Accept these as hints:
    // - price.amount => total (major units)
    // - price.perSeat => per-seat major units
    // - price.tax => tax amount (major units)
    let incomingPrice = price || null;
    let incomingPerSeat = null;
    let incomingTotal = null;
    let incomingTax = null;
    let currency = 'INR';

    if (incomingPrice && typeof incomingPrice === 'object') {
      currency = incomingPrice.currency || currency;
      if (typeof incomingPrice.perSeat === 'number' || (typeof incomingPrice.perSeat === 'string' && incomingPrice.perSeat !== '')) {
        incomingPerSeat = Number(incomingPrice.perSeat) || null;
      }
      if (typeof incomingPrice.amount === 'number' || (typeof incomingPrice.amount === 'string' && incomingPrice.amount !== '')) {
        incomingTotal = Number(incomingPrice.amount) || null;
      }
      if (typeof incomingPrice.tax === 'number' || (typeof incomingPrice.tax === 'string' && incomingPrice.tax !== '')) {
        incomingTax = Number(incomingPrice.tax) || 0;
      }
    } else if (incomingPrice) {
      incomingTotal = Number(incomingPrice) || null;
    }

    if (typeof req.body.tax !== 'undefined' && req.body.tax !== null && incomingTax === null) {
      const t = Number(req.body.tax);
      if (!Number.isNaN(t)) incomingTax = t;
    }

    // Build seatsMeta - REQUIRE client-provided seatsMeta and sanitize entries
    // --- PATCHED: Build seatsMeta - prefer client-provided seatsMeta; fallback to computed per-seat prices ---
    let seatsMetaForSave = [];
    try {
      if (Array.isArray(seatsMeta) && seatsMeta.length) {
        // sanitize provided seatsMeta
        seatsMetaForSave = seatsMeta.map(s => {
          const seatId = String(s.seatId || s.seat || s.label || s.id || '');
          const seatClass = s.seatClass || s.class || s.category || null;
          const priceModifier = (typeof s.priceModifier === 'number') ? Number(s.priceModifier) : (typeof s.priceModifier === 'string' ? Number(String(s.priceModifier).replace(/[^\d.-]/g, '')) || 0 : 0);
          const priceVal = (typeof s.price === 'number') ? Number(s.price) : (typeof s.price === 'string' ? Number(String(s.price).replace(/[^\d.-]/g, '')) || 0 : 0);
          return {
            seatId,
            seatClass,
            priceModifier: Number(priceModifier || 0),
            price: Number(Math.round(priceVal || 0))
          };
        });
      } else {
        // seatsMeta missing -> compute from helpful hints
        const countSeats = normalizedSeats.length || 0;

        // 1) If frontend supplied per-seat hint, use that for all seats
        if (incomingPerSeat && Number.isFinite(Number(incomingPerSeat)) && Number(incomingPerSeat) > 0) {
          seatsMetaForSave = normalizedSeats.map(ns => {
            const seatLabel = String(ns && (ns.seatId || ns.label || ns.seat || ns.id) || ns || '');
            return { seatId: seatLabel, seatClass: null, priceModifier: 0, price: Math.round(Number(incomingPerSeat)) };
          });
        } else {
          // 2) If flight metadata contains a base fare or price and seat count > 0, distribute equally as a fallback
          const flightBase = (() => {
            try {
              // common shapes: flight.price.amount, flight.baseFare, flight.fare, flight.fares?.base
              if (!flight) return null;
              if (flight.price && (typeof flight.price.amount === 'number' || typeof flight.price.amount === 'string')) return Number(flight.price.amount);
              if (typeof flight.baseFare === 'number') return Number(flight.baseFare);
              if (typeof flight.fare === 'number') return Number(flight.fare);
              if (flight.fares && flight.fares.base) return Number(flight.fares.base);
              return null;
            } catch (e) { return null; }
          })();

          if (flightBase !== null && countSeats > 0) {
            const perSeat = Math.round(Number(flightBase) / countSeats);
            seatsMetaForSave = normalizedSeats.map(ns => {
              const seatLabel = String(ns && (ns.seatId || ns.label || ns.seat || ns.id) || ns || '');
              return { seatId: seatLabel, seatClass: null, priceModifier: 0, price: perSeat };
            });
          } else {
            // 3) Last resort: use computeSeatPriceForServer heuristics if available per seat object
            seatsMetaForSave = normalizedSeats.map((ns, idx) => {
              const seatLabel = String(ns && (ns.seatId || ns.label || ns.seat || ns.id) || ns || '');
              // construct a lightweight seat object for computeSeatPriceForServer
              const seatObj = Object.assign({}, ns || {}, { seatId: seatLabel });
              // use baseFareMajor as incomingPerSeat or flightBase if present
              const baseFareMajor = (incomingPerSeat && Number.isFinite(Number(incomingPerSeat)) && Number(incomingPerSeat) > 0) ? Number(incomingPerSeat) : (flightBase !== null ? Number(flightBase) : 0);
              // compute; ensure integer rounding
              let p = 0;
              try {
                p = Math.round(Number(computeSeatPriceForServer(seatObj, baseFareMajor) || 0));
              } catch (e) { p = 0; }
              return { seatId: seatLabel, seatClass: seatObj.seatClass || null, priceModifier: Number(seatObj.priceModifier || 0), price: Number(p || 0) };
            });
          }
        }
      }

      // final sanity: ensure we have per-seat prices for every seat and non-zero total (or fail)
      const missingPriceCount = seatsMetaForSave.filter(s => !s || !Number.isFinite(Number(s.price)) || Number(s.price) <= 0).length;
      if (seatsMetaForSave.length === 0 || (missingPriceCount > 0 && seatsMetaForSave.length > 0)) {
        // If we ended up with incomplete per-seat prices, abort to avoid creating zero-valued bookings unintentionally
        return res.status(400).json({ success: false, message: 'seatsMeta required in request or missing per-seat prices (server attempted fallbacks but failed)' });
      }
    } catch (e) {
      // unexpected sanitizer error -> fail safe
      console.error('[bookings] seatsMeta for save error', e && e.stack ? e.stack : e);
      return res.status(400).json({ success: false, message: 'Invalid seatsMeta' });
    }

    // computed total from seatsMeta (FRONTEND authoritative)
    const computedTotalFromSeats = seatsMetaForSave.reduce((acc, s) => acc + (Number(s.price) || 0), 0);

    // Compute addons total and normalize addons (server-authoritative lookup if Addon model exists)
    let AddonModel = null;
    try { AddonModel = require('../models/Addon'); } catch (e) { AddonModel = null; }

    let addonsForSave = [];
    let addonsTotal = 0;
    try {
      if (Array.isArray(addons) && addons.length) {
        // Format of incoming addons: { offerId/offerId, qty } or { offerId, amount, qty, metadata }
        for (const a of addons) {
          const code = (a && (a.code || a.key || a.offerId || a.id)) ? String(a.code || a.key || a.offerId || a.id).toUpperCase() : null;
          const qty = Number(a.qty || a.Qty || 1) || 1;
          if (!code) continue;

          // If AddonModel available, fetch canonical addon
          if (AddonModel) {
            try {
              const dbA = await AddonModel.findOne({ $or: [{ code }, { _id: a.offerId }, { id: a.offerId }], active: true }).lean();
              if (!dbA) {
                // fallback: accept provided amount if present
                const amt = Math.round(Number(a.amount ?? a.price ?? a.value ?? 0) || 0);
                const name = a.name || a.title || code;
                const metadata = a.metadata || a.meta || null;
                addonsForSave.push({ code, name, amount: amt, qty, category: a.category || 'misc', metadata, createdAt: new Date() });
                addonsTotal += Math.round(amt * qty);
              } else {
                // check airline/seatClass constraints
                if (dbA.airline && flight && flight.airlineCode && String(dbA.airline).toUpperCase() !== String(flight.airlineCode).toUpperCase()) {
                  // addon not applicable -> skip
                  continue;
                }
                const amt = Math.round(Number(dbA.amount || 0));
                addonsForSave.push({
                  code: dbA.code || code,
                  name: dbA.name || dbA.title || code,
                  amount: amt,
                  qty,
                  category: dbA.category || 'misc',
                  metadata: dbA.metadata || {}
                });
                addonsTotal += Math.round(amt * qty);
              }
            } catch (e) {
              // on error, fallback to provided data
              const amt = Math.round(Number(a.amount ?? a.price ?? a.value ?? 0) || 0);
              const name = a.name || a.title || code;
              const metadata = a.metadata || a.meta || null;
              addonsForSave.push({ code, name, amount: amt, qty, category: a.category || 'misc', metadata, createdAt: new Date() });
              addonsTotal += Math.round(amt * qty);
            }
          } else {
            // no Addon model - accept provided shape
            const amt = Math.round(Number(a.amount ?? a.price ?? a.value ?? 0) || 0);
            const name = a.name || a.title || code;
            const metadata = a.metadata || a.meta || null;
            addonsForSave.push({ code, name, amount: amt, qty, category: a.category || 'misc', metadata, createdAt: new Date() });
            addonsTotal += Math.round(amt * qty);
          }
        }
      } else if (typeof req.body.addonsTotal === 'number') {
        addonsTotal = Math.round(req.body.addonsTotal || 0);
      }
    } catch (e) {
      addonsTotal = 0;
      addonsForSave = [];
    }

    // Normalize discounts (free-form) and coupons advanced validation
    let discountsForSave = [];
    let discountsTotalFromDiscounts = 0;
    try {
      if (Array.isArray(discounts) && discounts.length) {
        discountsForSave = (discounts || []).map(d => {
          const amt = Math.abs(Number(d.amount ?? d.value ?? 0) || 0);
          const name = d.name || d.reason || '';
          const metadata = d.metadata || d.meta || null;
          discountsTotalFromDiscounts += Math.round(amt);
          return { name, amount: Math.round(amt), reason: d.reason || '', metadata };
        });
      }
      // fallback top-level discount
      if (!discountsTotalFromDiscounts && req.body.discount) {
        const single = Math.abs(Number(req.body.discount || 0) || 0);
        if (single) {
          discountsTotalFromDiscounts += Math.round(single);
          discountsForSave.push({ name: 'discount', amount: Math.round(single) });
        }
      }
    } catch (e) {
      discountsTotalFromDiscounts = 0;
      discountsForSave = [];
    }

    // Coupons - advanced: validate each (best-effort) and create normalized coupons array
    const couponsInput = Array.isArray(coupons) ? coupons : (coupons ? [coupons] : []);
    const couponsNormalized = [];
    for (const c of couponsInput) {
      const normalized = await validateAndNormalizeCoupon(c, finalUserId, { fare: computedTotalFromSeats, flight });
      couponsNormalized.push(normalized);
    }

    // Compute discounts from coupons (percentage or absolute) — respects cap
    const { discountsTotal: couponsComputedTotal, breakdown: couponBreakdown } = computeDiscountFromCoupons(couponsNormalized, computedTotalFromSeats + addonsTotal - discountsTotalFromDiscounts);

    const discountsTotal = Math.round(discountsTotalFromDiscounts + (couponsComputedTotal || 0));

    // === CRITICAL: Use UI-provided seatsMeta as canonical pricing ===
    // computedTotalFromSeats already derived from seatsMetaForSave (sum of per-seat prices)
    let computedTotal = Number(computedTotalFromSeats || 0);

    // === TAX: follow UI logic: tax is 5% on (seats + addons - discounts) ===
    const seatsSubtotal = Number(Math.round(computedTotal || 0));
    const computedBeforeTax = Math.round(seatsSubtotal + Math.round(addonsTotal || 0) - Math.round(discountsTotal || 0));
    let taxVal = Math.round(Math.max(0, computedBeforeTax) * 0.05);
    // if incomingTax explicitly provided by client, prefer that as supplemental hint but do not override UI logic:
    if (typeof incomingTax === 'number' && !Number.isNaN(incomingTax)) {
      // Keep computed tax as authoritative; you may log difference for monitoring
      if (Math.round(incomingTax) !== taxVal) {
        console.warn('[bookings] incomingTax hint differs from computed tax (authoritative): incoming:', incomingTax, 'computed:', taxVal);
      }
    }

    const finalTotal = Number.isFinite(Number(Math.round(computedBeforeTax + (taxVal || 0)))) ? Math.round(computedBeforeTax + (taxVal || 0)) : Math.round(computedBeforeTax);

    const bookingPrice = {
      amount: Number(Math.round(finalTotal || 0)),
      currency: (currency || 'INR'),
      tax: Number(Math.round(taxVal || 0)),
      taxes: Number(Math.round(taxVal || 0)),
      discount: Number(Math.round(discountsTotal || 0)),
      addonsTotal: Number(Math.round(addonsTotal || 0)),
      discountsTotal: Number(Math.round(discountsTotal || 0))
    };

    // Persist seats in schema-compatible structure { row, col, label } and seatsMeta saved
    const seatsForSave = Array.isArray(normalizedSeats)
      ? normalizedSeats.map(ns => {
        const seatLabel = (ns && (ns.seatId || ns.label || ns.seat || ns.id)) || String(ns || '');
        return { row: null, col: null, label: String(seatLabel) };
      })
      : [];

    // Build booking object
    const bookingData = {
      userId: finalUserId,
      flightId: flight && (flight._id || flight.id) ? (flight._id || flight.id) : flightId,
      seatMapId: map ? map._id : null,
      provider: (flight && flight.provider) || process.env.AIRLINE_PROVIDER || 'mock',
      providerBookingId: `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      passengers: normalizedPassengers,
      contact,
      price: bookingPrice,
      status: (flight && flight.defaultBookingStatus) || 'HELD',
      rawProviderResponse: { note: 'local-held' },
      idempotencyKey: idempotencyKey || undefined,
      paymentStatus: 'PENDING',
      bookingStatus: 'PENDING',
      reconciliationAttempts: 0,
      stripeSessionId: null,
      paymentIntentId: null,
      paymentId: null,
      paymentProvider: null,
      seats: seatsForSave,
      seatsMeta: seatsMetaForSave,
      addons: addonsForSave,
      coupons: couponsNormalized.map(c => {
        // ensure appliedAt is present
        return Object.assign({}, c, { appliedAt: c.appliedAt ? new Date(c.appliedAt) : new Date() });
      }),
      discounts: discountsForSave
    };

    if (!bookingData.bookingRef) bookingData.bookingRef = generateBookingRef();

    const booking = new Booking(bookingData);
    await booking.save();

    // Ensure numeric price.amount (string edge-cases)
    try {
      if (booking.price && (typeof booking.price.amount === 'string')) {
        booking.price.amount = Number(String(booking.price.amount).replace(/[^\d.-]/g, '')) || Number(booking.price.amount) || 0;
        await booking.save();
      }
    } catch (e) { /* non-fatal */ }

    // store idempotency map if model exists
    if (idempotencyKey && Idempotency) {
      try {
        await Idempotency.create({ key: idempotencyKey, bookingId: booking._id.toString() });
      } catch (e) {
        try {
          const map = await Idempotency.findOne({ key: idempotencyKey }).lean();
          if (map && map.bookingId) {
            const existingBooking = await Booking.findById(map.bookingId).lean();
            if (existingBooking) return res.status(200).json({ success: true, booking: existingBooking, idempotent: true });
          }
        } catch (ee) { /* ignore */ }
      }
    }

    // optional provider booking (best-effort). Provide addons & coupons to provider if supported
    if (airlines && typeof airlines.bookFlight === 'function') {
      try {
        const providerResp = await airlines.bookFlight({
          provider: booking.provider,
          bookingPayload: {
            flightId: booking.flightId,
            passengers: booking.passengers,
            contact: booking.contact,
            seats: booking.seats,
            addons: booking.addons,
            coupons: booking.coupons,
            idempotencyKey
          }
        });
        if (providerResp) {
          booking.providerBookingId = providerResp.providerBookingId || booking.providerBookingId;
          booking.rawProviderResponse = providerResp.raw || providerResp;
          const providerStatus = (providerResp.ticketStatus || 'HELD').toUpperCase();
          if (providerStatus === 'CONFIRMED' || providerStatus === 'TICKETED') booking.status = providerStatus;
          await booking.save();
        }
      } catch (provErr) {
        console.error('[bookings] provider.book error', provErr && provErr.message);
      }
    }

    // generate pdf itinerary (non-blocking) and optionally email
    if (emailer && typeof emailer.generateItineraryPDF === 'function') {
      (async () => {
        try {
          // pass booking (mongoose doc) - emailer.generateItineraryPDF handles toObject
          const pdfBuffer = await emailer.generateItineraryPDF(booking);
          if (Buffer.isBuffer(pdfBuffer)) {
            // optionally email or store; by default we log preview
            console.log('[bookings] itinerary PDF generated (size bytes):', pdfBuffer.length);
          } else {
            console.warn('[bookings] generateItineraryPDF did not return a Buffer');
          }
        } catch (pdfErr) {
          console.error('[bookings] generateItineraryPDF error', pdfErr && (pdfErr.stack || pdfErr.message || pdfErr));
        }
      })();
    } else {
      if (!emailer) console.warn('[bookings] emailer utility not found; skipping PDF generation.');
    }

    // Optionally create stripe session (same as before)
    const shouldCreateSession = (String(req.query.createSession || '').toLowerCase() === 'true') || createSession === true;
    if (shouldCreateSession) {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return res.status(201).json({ success: true, booking, idempotent: false, providerError: 'Stripe not configured' });
      }
      try {
        const Stripe = require('stripe');
        const stripe = Stripe(stripeKey);

        const currencyFinal = (booking.price && booking.price.currency) || 'INR';
        const amountForStripe = toStripeAmount(booking.price.amount || 0, currencyFinal);

        const successUrl = `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/booking-details/${encodeURIComponent(booking.bookingRef || booking._id)}?paid=true`;

        booking.stripeSessionParams = {
          mode: 'payment',
          payment_method_types: ['card'],
          customer_email: booking.contact.email,
          line_items: [{
            price_data: {
              currency: booking.price.currency || 'INR',
              product_data: {
                name: `Flight Booking ${booking.bookingRef}`
              },
              unit_amount: Math.round(booking.price.amount * 100)
            },
            quantity: 1
          }],
          success_url: `${process.env.FRONTEND_URL}/booking-details/${booking.bookingRef}?payment=true`,
          cancel_url: `${process.env.FRONTEND_URL}/booking-details/${booking.bookingRef}?payment=cancelled`,
          metadata: {
            bookingId: booking._id.toString(),
            bookingRef: booking.bookingRef
          }
        };

        // booking.stripeSessionId = session.id || booking.stripeSessionId;
        // if (session.payment_intent) booking.paymentIntentId = session.payment_intent;
        booking.paymentStatus = 'PENDING';
        booking.bookingStatus = booking.bookingStatus || 'PENDING';
        await booking.save();

        return res.status(201).json({ success: true, booking, session: { id: session.id, url: session.url || null }, couponBreakdown: couponBreakdown || [] });
      } catch (err) {
        console.error('[bookings] create session error', err && (err.stack || err));
        return res.status(201).json({ success: true, booking, providerError: err.message || 'session creation failed', couponBreakdown: couponBreakdown || [] });
      }
    }

    // Normal: return created booking, and send couponBreakdown for frontend display
    return res.status(201).json({ success: true, booking, couponBreakdown: couponBreakdown || [] });
  } catch (err) {
    console.error('[bookings] create error', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'server error', error: err && err.message });
  }
};

/** Remaining handlers (getOne, updateStatus, listByUser, listMine, getByRef, resendConfirmation)
 *  Keep them minimal and similar to prior implementations.
 */

exports.getOne = async (req, res) => {
  try {
    const id = req.params.id;
    let booking = null;

    if (mongoose.isValidObjectId(id)) {
      booking = await Booking.findById(id).lean();
    }

    if (!booking) {
      booking = await Booking.findOne({ $or: [{ bookingRef: id }, { id: id }] }).lean();
    }

    if (!booking) return res.status(404).json({ success: false, message: 'Not found' });
    return res.json({ success: true, booking });
  } catch (err) {
    console.error('[bookings] getOne error', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};

exports.updateStatus = async (req, res) => {
  try {
    const id = req.params.id;
    const { status, providerBookingId, rawProviderResponse, paymentStatus, bookingStatus, stripeSessionId, paymentIntentId, paymentId, paymentProvider } = req.body || {};

    if (!status && !providerBookingId && !rawProviderResponse && !paymentStatus && !bookingStatus && !stripeSessionId && !paymentIntentId && !paymentId && !paymentProvider) {
      return res.status(400).json({ success: false, message: 'no updatable fields provided' });
    }

    let booking;
    if (mongoose.isValidObjectId(id)) booking = await Booking.findById(id);
    else booking = await Booking.findOne({ bookingRef: id });

    if (!booking) return res.status(404).json({ success: false, message: 'booking not found' });

    if (status) booking.status = status;
    if (providerBookingId) booking.providerBookingId = providerBookingId;
    if (rawProviderResponse) booking.rawProviderResponse = rawProviderResponse;

    if (paymentStatus) booking.paymentStatus = paymentStatus;
    if (bookingStatus) booking.bookingStatus = bookingStatus;
    // 🎟️ Phase C: initialize ticketing once payment succeeds
    if (paymentStatus === 'PAID') {
      booking.ticketStatus = 'PENDING';
      booking.ticketingAttempts = 0;
    }

    if (stripeSessionId) booking.stripeSessionId = stripeSessionId;
    if (paymentIntentId) booking.paymentIntentId = paymentIntentId;
    if (paymentId) booking.paymentId = paymentId;
    if (paymentProvider) booking.paymentProvider = paymentProvider;

    booking.lastReconciledAt = new Date();

    await booking.save();
    res.json({ success: true, booking });
  } catch (err) {
    console.error('[bookings] updateStatus error', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, message: 'server error' });
  }
};

exports.listByUser = async (req, res) => {
  try {
    const userId = req.params.userId || req.query.userId;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });
    const rows = await Booking.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, bookings: rows });
  } catch (err) {
    console.error('[bookings] listByUser error', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, message: 'server error' });
  }
};

exports.listMine = async (req, res) => {
  try {
    const userId = req.userId || (req.user && (req.user._id || req.user.id));
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const rows = await Booking.find({
      $or: [{ userId: String(userId) }, { user: String(userId) }]
    }).sort({ createdAt: -1 }).lean();

    return res.json({ success: true, bookings: rows });
  } catch (err) {
    console.error('[bookings] listMine error', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};

exports.getByRef = async (req, res) => {
  try {
    const ref = req.params.ref;
    if (!ref) return res.status(400).json({ success: false, message: 'ref required' });
    const booking = await Booking.findOne({ bookingRef: ref }).lean();
    if (!booking) return res.status(404).json({ success: false, message: 'not found' });
    return res.json({ success: true, booking });
  } catch (err) {
    console.error('[bookings] getByRef error', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, message: 'server error' });
  }
};

exports.resendConfirmation = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'booking id required' });

    // find booking by id or bookingRef
    let booking = null;
    if (mongoose.isValidObjectId(id)) booking = await Booking.findById(id);
    if (!booking) booking = await Booking.findOne({ bookingRef: id });
    if (!booking) return res.status(404).json({ success: false, message: 'booking not found' });

    const emailerUtil = (() => { try { return require('../utils/emailer'); } catch (e) { return null; } })();
    if (!emailerUtil || typeof emailerUtil.sendBookingConfirmation !== 'function') {
      return res.status(500).json({ success: false, message: 'emailer utility not available' });
    }

    try {
      const result = await emailerUtil.sendBookingConfirmation(booking);
      return res.json({
        success: true,
        message: 'confirmation sent (or previewed)',
        info: result
      });
    } catch (err) {
      // Never fail the API for resend-confirmation
      console.error('[bookings] resendConfirmation email failed', err && (err.stack || err.message || err));
      return res.status(200).json({
        success: false,
        message: 'confirmation generated but email delivery failed'
      });
    }
  } catch (err) {
    console.error('[bookings] resendConfirmation fatal', err && err.stack ? err.stack : err);
    res.status(500).json({ success: false, message: 'server error' });
  }
};

/**
 * GET /api/bookings/:id/itinerary.pdf
 * Download booking itinerary as PDF
 */
exports.downloadItineraryPDF = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send('booking id required');

    let booking = null;

    if (mongoose.isValidObjectId(id)) {
      booking = await Booking.findById(id);
    }
    if (!booking) {
      booking = await Booking.findOne({ bookingRef: id });
    }
    if (!booking) {
      return res.status(404).send('booking not found');
    }

    if (!pdfUtils || typeof pdfUtils.generateItineraryPDF !== 'function') {
      return res.status(500).send('PDF generator not available');
    }

    const pdfBuffer = await pdfUtils.generateItineraryPDF(booking);

    if (!Buffer.isBuffer(pdfBuffer)) {
      return res.status(500).send('Failed to generate PDF');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${booking.bookingRef || 'itinerary'}.pdf`
    );

    res.send(pdfBuffer);
  } catch (err) {
    console.error('[bookings] downloadItineraryPDF error', err);
    res.status(500).send('server error');
  }
};


/**
 * POST /api/bookings/:id/cancel
 * Body:
 *  {
 *    refund: true|false,
 *    refundAmount: <major units> (optional),
 *    reason: <string> (optional),
 *    restoreInventory: true|false (optional, default true)
 *  }
 *
 * Permission:
 * - booking owner or admin only (best-effort)
 */
exports.cancel = async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    const doRefund = body.refund !== false;
    const restoreInventory = body.restoreInventory !== false;
    const reason = body.reason || 'cancelled';
    const caller = req.userId || req.ip || 'unknown';

    // 1️⃣ Load booking
    let booking = null;
    if (mongoose.isValidObjectId(id)) {
      booking = await Booking.findById(id);
    }
    if (!booking) {
      booking = await Booking.findOne({ bookingRef: id });
    }
    if (!booking) {
      return res.status(404).json({ success: false, message: 'booking not found' });
    }

    if (String(booking.bookingStatus || booking.status || '').toUpperCase() === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'already-cancelled' });
    }

    // 2️⃣ Compute cancellation fee & NET refund
    const totalPaid = Number(booking?.price?.amount || 0);
    const cancellationFeeMajor = Math.round(totalPaid * 0.10); // 10%
    const refundMajor = Math.max(0, totalPaid - cancellationFeeMajor);

    booking.cancellationFeeMajor = cancellationFeeMajor;
    booking.cancelledAt = new Date();
    booking.bookingStatus = 'CANCELLED';
    booking.status = 'CANCELLED';
    booking.paymentStatus = 'CANCELLED_PENDING_REFUND';

    booking.rawProviderResponse = booking.rawProviderResponse || {};
    booking.rawProviderResponse.cancelledBy = caller;
    booking.rawProviderResponse.cancelReason = reason;

    await booking.save();

    // 3️⃣ Refund NET amount only
    let refundResult = null;
    if (doRefund) {
      refundResult = await paymentsCtrl.refundPaymentHelper({
        bookingIdentifier: booking._id,
        paymentIntentId: booking.paymentIntentId,
        amountMajor: refundMajor, // ✅ NET refund
        currency: booking.price.currency,
        cancelBooking: false
      });

      if (!refundResult?.ok) {
        return res.status(502).json({
          success: false,
          message: refundResult.message || 'refund_failed',
          raw: refundResult
        });
      }
    }
    await booking.save();
    // 4️⃣ Restore seats (FIXED)
    let seatRestore = null;
    if (restoreInventory) {
      seatRestore = await restoreSeatsForBooking(booking);
    }

    const updatedBooking = await Booking.findById(booking._id).lean();

    // 4.5️⃣ Send cancellation email (BEST-EFFORT, NON-BLOCKING)
    try {
      await sendCancellationEmail(booking, {
        cancellationFeeMajor,
        refundMajor,
        refundRaw: refundResult?.refund || null
      });
      console.log(
        '[bookings.cancel] cancellation email triggered for',
        booking.bookingRef
      );
    } catch (e) {
      console.warn(
        '[bookings.cancel] cancellation email failed',
        e?.message || e
      );
    }


    return res.json({
      success: true,
      message: 'cancelled',
      booking: updatedBooking,
      refund: refundResult?.refund || null,
      cancellationFeeMajor,
      refundAmountMajor: refundMajor,
      seatRestore
    });

  } catch (err) {
    console.error('[bookings.cancel] fatal', err);
    return next(err);
  }
};


// add near other exports in controllers/bookingsController.js

/**
 * GET /bookings/:id/cancellation-policy
 * Returns cancellation policy for booking or flight or default policy
 */
exports.getCancellationPolicy = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'id required' });

    // attempt to find booking by id or ref
    let booking = null;
    try {
      if (mongoose.isValidObjectId(id)) booking = await Booking.findById(id).lean();
    } catch (e) { /* ignore */ }
    if (!booking) booking = await Booking.findOne({ bookingRef: id }).lean();

    // If booking exists and has cancellationPolicySnapshot or cancellationPolicy, return that
    if (booking) {
      const policy = booking.cancellationPolicySnapshot || booking.cancellationPolicy || (booking.flight && booking.flight.cancellationPolicy) || null;
      if (policy) return res.json({ success: true, policy });
      // If policy absent, but booking has cancellationFeeMajor stored, return info
      if (typeof booking.cancellationFeeMajor === 'number') {
        return res.json({ success: true, policy: { type: 'computed', cancellationFeeMajor: booking.cancellationFeeMajor } });
      }
    }

    // Otherwise, attempt to find flight-level policy (if you have a Flight model)
    // If you have a Flight model, swap following logic to fetch flight info.
    // For now check booking rawProviderResponse.flight or booking.flightId
    let flightPolicy = null;
    try {
      const flightId = booking && (booking.flightId || booking.rawProviderResponse?.flightId) || null;
      if (flightId) {
        // if you have flights collection, try loading it (optional)
        // const Flight = require('../models/Flight');
        // const f = await Flight.findById(flightId).lean().catch(() => null);
        // flightPolicy = f && f.cancellationPolicy ? f.cancellationPolicy : null;
        // fallback: maybe booking.rawProviderResponse contains policy
        if (booking && booking.rawProviderResponse && booking.rawProviderResponse.cancellationPolicy) {
          flightPolicy = booking.rawProviderResponse.cancellationPolicy;
        }
      }
    } catch (e) { /* ignore */ }

    if (flightPolicy) return res.json({ success: true, policy: flightPolicy });

    // default fallback
    const defaultPolicy = { type: 'percent', value: 10, note: 'Default cancellation policy: 10% fee' };
    return res.json({ success: true, policy: defaultPolicy });
  } catch (err) {
    console.error('[bookings.getCancellationPolicy] err', err && (err.stack || err));
    return next(err);
  }
};
