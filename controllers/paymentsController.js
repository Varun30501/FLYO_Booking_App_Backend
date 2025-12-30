'use strict';

const StripeLib = require('stripe');
const Booking = require('../models/Booking');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_ENDPOINT_SECRET || '';
const stripe = STRIPE_SECRET ? StripeLib(STRIPE_SECRET) : null;

/** Find booking by id or bookingRef (returns mongoose doc for updates) */
async function findBookingByAny(identifier) {
  if (!identifier) return null;
  try {
    if (mongoose.isValidObjectId(identifier)) {
      const byId = await Booking.findById(identifier);
      if (byId) return byId;
    }
  } catch (e) { /* ignore */ }
  const byRef = await Booking.findOne({ $or: [{ bookingRef: identifier }, { booking_ref: identifier }] });
  if (byRef) return byRef;
  return null;
}

/** Parse incoming amount robustly and return numeric major units */
function parseMajorAmount(value) {
  if (value === null || typeof value === 'undefined') return NaN;
  if (typeof value === 'number') return Number(value);
  const s = String(value).trim();
  const cleaned = s.replace(/[^\d\.\-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Parse seat price candidate */
function parseSeatPriceCandidate(v) {
  if (v === null || typeof v === 'undefined') return 0;
  if (typeof v === 'number') return Number(v) || 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** sum seatsMeta prices robustly (accepts strings/numbers) */
function sumSeatsMetaPrice(seatsMeta) {
  if (!Array.isArray(seatsMeta)) return 0;
  return seatsMeta.reduce((acc, s) => {
    const p = parseSeatPriceCandidate((s && (s.price ?? s.amount ?? s.priceAmount)) || 0);
    return acc + (Number(p) || 0);
  }, 0);
}

function sumAddons(addons) {
  if (!Array.isArray(addons)) return 0;
  return addons.reduce((acc, a) => {
    const amt = Number(a.amount ?? a.price ?? 0) || 0;
    const qty = Number(a.qty ?? 1) || 1;
    return acc + (Math.round(amt) * qty);
  }, 0);
}

function sumDiscountsAndCoupons(booking) {
  let total = 0;
  if (!booking) return 0;
  if (Array.isArray(booking.discounts)) {
    booking.discounts.forEach(d => {
      total += Math.abs(Number(d.amount || 0) || 0);
    });
  }
  if (Array.isArray(booking.coupons)) {
    booking.coupons.forEach(c => total += Math.abs(Number(c.amount || 0) || 0));
  }
  // fallback single field
  if (booking.price && (Number.isFinite(Number(booking.price.discount)) || Number.isFinite(Number(booking.discount)))) {
    total += Math.abs(Number(booking.price.discount ?? booking.discount ?? 0) || 0);
  }
  return Math.round(total);
}


/**
 * refundPaymentHelper
 * Attempts to refund a booking or explicit charge/payment_intent.
 *
 * Params:
 *  - bookingIdentifier: bookingId or bookingRef
 *  - chargeId: explicit Stripe charge id (ch_...)
 *  - paymentIntentId: explicit PI id (pi_...)
 *  - amountMajor: refund amount in major units (rupees)
 *  - currency: default INR
 *  - idempotencyKey: forwarded to Stripe
 *  - cancelBooking: mark booking cancelled after refund
 *  - restoreInventory: boolean - attempt to restore seat inventory after refund
 *
 * Returns: { ok, refund, booking?, message?, error?, info? }
 */
async function refundPaymentHelper({ bookingIdentifier, chargeId, paymentIntentId, amountMajor = null, currency = 'INR', idempotencyKey = null, cancelBooking = false, restoreInventory = false } = {}) {
  if (!stripe) return { ok: false, message: 'stripe-not-configured' };

  // Try to locate booking if identifier provided
  let booking = null;
  if (bookingIdentifier) {
    try {
      booking = await findBookingByAny(bookingIdentifier);
    } catch (e) {
      console.warn('[payments.refund] findBookingByAny error', e && e.message);
    }
  }

  // Prefer explicit ids over booking fields
  let pi = paymentIntentId || (booking && (booking.paymentIntentId || booking.payment_intent || booking.paymentIntent || booking.paymentId));
  let charge = chargeId || (booking && (booking.paymentId || booking.chargeId || booking.charge || booking.charge_id));

  // Normalize accidental pi passed in charge
  if (charge && typeof charge === 'string' && String(charge).startsWith('pi_') && !pi) {
    pi = charge;
    charge = null;
  }

  // If we have a booking with stripeSessionId, try to expand session to find PI/charge
  if (!pi && booking && booking.stripeSessionId && stripe) {
    try {
      const sess = await stripe.checkout.sessions.retrieve(String(booking.stripeSessionId));
      if (sess) {
        pi = pi || (sess.payment_intent || sess.paymentIntent || sess.payment_intent_id);
        // if we have PI, try to expand to get charge
        if (pi && !charge) {
          try {
            const piObj = await stripe.paymentIntents.retrieve(String(pi), { expand: ['charges.data'] });
            if (piObj && Array.isArray(piObj.charges?.data) && piObj.charges.data.length > 0) {
              const ch = piObj.charges.data.find(c => c && c.status === 'succeeded') || piObj.charges.data[0];
              if (ch && ch.id) charge = ch.id;
            }
          } catch (e) {
            console.warn('[payments.refund] expand PI failed (non-fatal)', e && e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[payments.refund] fetch session failed (non-fatal)', e && (e.message || e));
    }
  }

  // If still no PI/charge but booking has stripeSessionParams with response, attempt to glean
  if (!pi && !charge && booking && booking.stripeSessionParams) {
    try {
      const p = booking.stripeSessionParams;
      if (p && p.response) {
        if (p.response.payment_intent) pi = p.response.payment_intent;
        if (p.response.charge) charge = p.response.charge;
        // try to expand PI if present to derive a charge
        if (pi && !charge) {
          try {
            const piObj = await stripe.paymentIntents.retrieve(String(pi), { expand: ['charges.data'] });
            if (piObj && Array.isArray(piObj.charges?.data) && piObj.charges.data.length > 0) {
              const ch = piObj.charges.data.find(c => c && c.status === 'succeeded') || piObj.charges.data[0];
              if (ch && ch.id) charge = ch.id;
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // At this point require either a PI or a charge to proceed (Stripe accepts PI or charge)
  if (!pi && !charge) {
    return { ok: false, message: 'no-charge-or-paymentIntent-found', info: 'Provide bookingIdentifier (with payment) or paymentIntentId/chargeId' };
  }

  // compute currency multiplier and smallest unit
  const currencyLower = String(currency || (booking && booking.price && booking.price.currency) || 'INR').toLowerCase();
  const multiplier = (currencyLower === 'jpy') ? 1 : 100;

  // Parse amountMajor robustly (strings/numbers)
  let amountSmallest = null;
  if (amountMajor !== null && typeof amountMajor !== 'undefined') {
    try {
      let amtNum = amountMajor;
      if (typeof amtNum === 'string') {
        const cleaned = amtNum.replace(/[^\d.\-]/g, '');
        amtNum = cleaned === '' ? NaN : Number(cleaned);
      }
      amtNum = Number(amtNum);
      if (!Number.isNaN(amtNum) && Number.isFinite(amtNum)) {
        if (Math.abs(amtNum) > 1e6) amountSmallest = Math.round(amtNum);
        else amountSmallest = Math.max(0, Math.round(Math.abs(amtNum) * multiplier));
      }
    } catch (e) {
      amountSmallest = null;
    }
  }

  // Build initial refundParams (we may prefer charge if available)
  const refundParams = {};
  if (charge) refundParams.charge = String(charge);
  else if (pi) refundParams.payment_intent = String(pi);
  if (amountSmallest !== null) refundParams.amount = Number(amountSmallest);

  // ----- NEW: check booking.refunds for previous refund of same charge/PI -----
  try {
    if (booking && Array.isArray(booking.refunds) && booking.refunds.length) {
      // normalize stored refund references to look for matching charge/payment_intent
      const already = booking.refunds.find(r => {
        if (!r) return false;
        const rid = String(r.id || r.refundId || r.refund_id || '').trim();
        const rCharge = String(r.charge || r.chargeId || r.charge_id || '').trim();
        const rPI = String(r.paymentIntent || r.payment_intent || r.paymentIntentId || '').trim();
        if (rid && (rid === refundParams.charge || rid === refundParams.payment_intent || rid === charge || rid === pi)) return true;
        if (rCharge && rCharge === (refundParams.charge || '')) return true;
        if (rPI && rPI === (refundParams.payment_intent || '')) return true;
        return false;
      });
      if (already) {
        return { ok: false, message: 'already-refunded', info: { ok: false, message: 'already-refunded', refunds: booking.refunds, found: already } };
      }
    }
  } catch (e) {
    console.warn('[payments.refund] checking booking.refunds failed (non-fatal)', e && e.message);
  }

  // ----- Defensive: query Stripe for refunds on this charge (if charge known) -----
  try {
    if (charge && stripe && typeof stripe.refunds.list === 'function') {
      const list = await stripe.refunds.list({ charge: String(charge), limit: 5 });
      if (list && Array.isArray(list.data) && list.data.length > 0) {
        // if any existing refund (succeeded or pending), return it rather than create new
        return { ok: false, message: 'already-refunded', info: { ok: false, message: 'already-refunded', stripeRefunds: list.data } };
      }
    }
  } catch (e) {
    console.warn('[payments.refund] stripe.refunds.list failed (non-fatal)', e && (e.message || e));
  }

  // Build stripe options (idempotency)
  const stripeOpts = {};
  stripeOpts.idempotencyKey = idempotencyKey ? String(idempotencyKey) : `refund-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Final normalization: if someone put pi_ in charge, convert
  if (refundParams.charge && String(refundParams.charge).startsWith('pi_')) {
    refundParams.payment_intent = refundParams.charge;
    delete refundParams.charge;
  }

  // If we only have payment_intent and not charge, try to expand to get a charge (prefer refunding by charge)
  if (!refundParams.charge && refundParams.payment_intent) {
    try {
      const piObj = await stripe.paymentIntents.retrieve(String(refundParams.payment_intent), { expand: ['charges.data'] });
      if (piObj && Array.isArray(piObj.charges?.data) && piObj.charges.data.length > 0) {
        const ch = piObj.charges.data.find(c => c && c.status === 'succeeded') || piObj.charges.data[0];
        if (ch && ch.id) {
          refundParams.charge = ch.id;
          // optional: keep payment_intent too, Stripe accepts either
        }
      }
    } catch (e) {
      console.warn('[payments.refund] expand PI to get charge failed (non-fatal)', e && (e.message || e));
    }
  }

  // Final safeguard: if booking.refunds gained a new refund while we were expanding, re-check
  try {
    if (booking && Array.isArray(booking.refunds) && booking.refunds.length) {
      const match = booking.refunds.find(r => {
        const rID = String(r.id || '').trim();
        if (!rID) return false;
        if (refundParams.charge && rID === refundParams.charge) return true;
        if (refundParams.payment_intent && rID === refundParams.payment_intent) return true;
        return false;
      });
      if (match) {
        return { ok: false, message: 'already-refunded', info: { ok: false, message: 'already-refunded', refunds: booking.refunds, found: match } };
      }
    }
  } catch (e) { /* ignore */ }

  // perform refund
  let refund = null;
  try {
    console.log('[payments.refund] about to call stripe.refunds.create', { refundParams, stripeOpts, bookingId: booking ? String(booking._id || booking.bookingRef) : null });
    refund = await stripe.refunds.create(refundParams, stripeOpts);
    // console.log('[payments.refund] stripe refund created', refund && refund.id);
  } catch (err) {
    console.error('[payments.refund] stripe.refunds.create error', err && (err.raw || err));
    const raw = err && (err.raw || err);
    return { ok: false, message: 'stripe-refund-failed', error: (raw && (raw.message || raw)) || (err && (err.message || String(err))), stripeError: raw || undefined };
  }

  // Persist refund into booking if booking found
  try {
    if (booking) {
      booking.refunds = Array.isArray(booking.refunds) ? booking.refunds : [];
      const persistedRefund = {
        id: refund.id,
        amount: (typeof refund.amount === 'number') ? refund.amount : undefined,
        currency: refund.currency || currencyLower,
        status: refund.status || null,
        reason: refund.reason || null,
        metadata: refund.metadata || {},
        createdAt: refund.created || Date.now(),
        raw: refund
      };

      booking.refunds.push(persistedRefund);

      // Update booking paymentStatus / bookingStatus
      try {
        const refundedTotalSmall = booking.refunds.reduce((acc, r) => acc + (Number(r.amount || 0) || 0), 0);
        const bookingTotalSmall = (booking.price && typeof booking.price.amount === 'number') ? Math.round(Number(booking.price.amount || 0) * multiplier) : null;
        if (bookingTotalSmall !== null && refundedTotalSmall >= bookingTotalSmall) {
          booking.paymentStatus = 'REFUNDED';
          booking.bookingStatus = booking.bookingStatus || 'CANCELLED';
          booking.status = booking.status || 'CANCELLED';
        } else {
          booking.paymentStatus = 'PARTIALLY_REFUNDED';
        }
      } catch (e) {
        if (refund && refund.status === 'succeeded') booking.paymentStatus = 'REFUNDED';
      }

      if (cancelBooking) {
        booking.bookingStatus = 'CANCELLED';
        booking.status = 'CANCELLED';
      }

      await booking.save();
    }
  } catch (err) {
    console.warn('[payments.refund] failed to persist refund to booking (non-fatal)', err && err.message);
  }

  // Attempt to restore seat inventory if requested (best-effort)
  if (restoreInventory && booking) {
    try {
      const seatService = (() => { try { return require('../services/seats'); } catch (e) { return null; } })();
      if (seatService) {
        // prefer restoreSeatsForBooking if present
        if (typeof seatService.restoreSeatsForBooking === 'function') {
          seatService.restoreSeatsForBooking(booking).catch(e => console.warn('[payments] restoreSeatsForBooking failed', e && e.message));
        } else if (typeof seatService.restoreSeats === 'function') {
          // fallback generic call
          try {
            seatService.restoreSeats(booking).catch(e => console.warn('[payments] restoreSeats failed', e && e.message));
          } catch (ex) { /* ignore */ }
        } else {
          console.warn('[payments] seat service found but no restore API (restoreInventory requested)');
        }
      } else {
        console.warn('[payments] restoreInventory requested but seat service not available');
      }
    } catch (e) {
      console.warn('[payments] restoreInventory call failed (non-fatal)', e && e.message);
    }
  }

  const bookingOut = booking ? (await Booking.findById(booking._id).lean().catch(() => (booking && booking.toObject ? booking.toObject() : booking))) : undefined;
  return { ok: true, refund, booking: bookingOut };
}


// Express route handler for refunds
exports.refundPayment = async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, message: 'Stripe not configured' });

    const body = req.body || {};
    const bookingIdentifier = body.bookingIdentifier || body.bookingId || body.bookingRef || null;
    const explicitAmount = (typeof body.amount !== 'undefined' && body.amount !== null) ? body.amount : null;
    const reason = body.reason || body.refundReason || 'requested_by_customer';
    const restoreInventory = !!body.restoreInventory;
    const cancelBooking = !!body.cancelBooking;
    const caller = req.userId || (req.user && req.user._id) || req.ip || 'unknown';
    const idempotencyKey = req.header('Idempotency-Key') || req.body.idempotencyKey || null;

    // decide amountMajor
    let amountMajor = null;
    if (explicitAmount !== null) {
      const parsed = parseMajorAmount(explicitAmount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid explicit amount' });
      }
      amountMajor = parsed;
    }

    // call helper - prefer bookingIdentifier
    const helperResult = await refundPaymentHelper({
      bookingIdentifier,
      chargeId: body.chargeId || body.paymentId || body.charge,
      paymentIntentId: body.paymentIntent || body.paymentIntentId,
      amountMajor: amountMajor,
      currency: body.currency || undefined,
      idempotencyKey: idempotencyKey,
      cancelBooking: cancelBooking,
      restoreInventory: restoreInventory
    });

    if (!helperResult) {
      return res.status(500).json({ success: false, message: 'internal error' });
    }

    if (!helperResult.ok) {
      // If helper returned known already-refunded info, return 400 with info
      if (helperResult.message === 'already-refunded') {
        return res.status(400).json({ error: 'already-refunded', info: helperResult.info || helperResult });
      }
      if (helperResult.message === 'stripe-not-configured') {
        return res.status(500).json({ success: false, message: 'Stripe not configured' });
      }
      // Stripe diagnostic
      if (helperResult.message === 'stripe-refund-failed') {
        return res.status(502).json({ success: false, message: 'stripe-refund-failed', raw: helperResult });
      }
      return res.status(400).json({ success: false, message: helperResult.message || 'refund failed', raw: helperResult });
    }

    // If restoreInventory not done inside helper for some reason, try here (best-effort)
    if (restoreInventory && helperResult.booking) {
      try {
        const seatService = (() => { try { return require('../services/seats'); } catch (e) { return null; } })();
        if (seatService && typeof seatService.restoreSeatsForBooking === 'function') {
          seatService.restoreSeatsForBooking(helperResult.booking).catch(e => console.warn('[payments] restoreSeatsForBooking failed', e && e.message));
        }
      } catch (e) { /* ignore */ }
    }

    return res.json({ success: true, message: 'refund_created', refund: helperResult.refund, booking: helperResult.booking });
  } catch (err) {
    console.error('[payments] refund handler fatal', err && (err.stack || err));
    return res.status(500).json({ success: false, message: 'server error', error: (err && err.message) || String(err) });
  }
};


// expose helper for use by other modules (bookingsController etc.)
exports.refundPaymentHelper = refundPaymentHelper;


/* --- existing createCheckoutSession + webhook handlers --- */

exports.createCheckoutSession = async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ message: 'Stripe not configured' });

    const { bookingId, bookingRef, amount, currency = undefined, metadata = {}, idempotencyKey: bodyIdempotencyKey } = req.body || {};

    // idempotency key can come in header or body
    const idempotencyKey = req.header('Idempotency-Key') || bodyIdempotencyKey || null;

    if (!bookingId && !bookingRef && (typeof amount === 'undefined' || amount === null)) {
      return res.status(400).json({ message: 'bookingId or bookingRef or amount required to create checkout session' });
    }

    let booking = null;
    if (bookingId) booking = await findBookingByAny(bookingId);
    if (!booking && bookingRef) booking = await findBookingByAny(bookingRef);

    // Decide amount source:
    // Priority:
    //  1) explicit body.amount override (developer)
    //  2) booking.seatsMeta sum (authoritative)
    //  3) booking.price.amount (fallback)
    let majorAmountCandidate = null;

    if (typeof amount !== 'undefined' && amount !== null) {
      majorAmountCandidate = parseMajorAmount(amount);
    } else if (booking && Array.isArray(booking.seatsMeta) && booking.seatsMeta.length) {
      const sum = sumSeatsMetaPrice(booking.seatsMeta);
      if (sum > 0) majorAmountCandidate = Number(sum);
    } else if (booking && booking.price && (typeof booking.price.amount !== 'undefined' && booking.price.amount !== null)) {
      majorAmountCandidate = parseMajorAmount(booking.price.amount);
    }

    if (!Number.isFinite(majorAmountCandidate)) {
      return res.status(400).json({ message: 'Invalid amount provided or computed' });
    }

    // Determine taxes
    // ✅ SINGLE SOURCE OF TRUTH — booking.price.amount
    if (!booking || !booking.price || !Number.isFinite(Number(booking.price.amount))) {
      return res.status(400).json({ message: 'Booking price missing or invalid' });
    }

    const majorAmountWithTaxes = Number(booking.price.amount);
    const taxes = Number(booking.price.tax || booking.price.taxes || 0);
    const addonsTotal = Number(booking.price.addonsTotal || 0);
    const discountsTotal = Number(booking.price.discountsTotal || 0);

    // Persist authoritative price back to booking if present
    if (booking) {
      try {
        const newPriceObj = booking.price && typeof booking.price === 'object' ? { ...booking.price } : { currency: (booking.price && booking.price.currency) || 'INR' };
        newPriceObj.amount = Number(Math.round(majorAmountWithTaxes || 0));
        newPriceObj.taxes = Number(taxes || 0);
        newPriceObj.addonsTotal = Number(addonsTotal || 0);
        newPriceObj.discountsTotal = Number(discountsTotal || 0);
        booking.price = newPriceObj;
        // persist idempotencyKey for traceability if provided
        if (idempotencyKey) booking.idempotencyKey = idempotencyKey;
        await booking.save();
      } catch (err) {
        console.warn('[payments] could not persist booking price before session creation', err && (err.message || err));
      }
    }

    // currency
    const currencyFinal = currency || (booking && booking.price && booking.price.currency) || 'INR';
    const currencyLower = String(currencyFinal).toLowerCase();

    // Stripe unit amount (smallest currency unit)
    const multiplier = (currencyLower === 'jpy') ? 1 : 100;

    // Heuristic: if major amount looks huge (>1e6) assume already smallest unit
    let unitAmount;
    if (Math.abs(majorAmountWithTaxes) > 1e6) {
      unitAmount = Math.round(majorAmountWithTaxes);
    } else {
      unitAmount = Math.max(0, Math.round(majorAmountWithTaxes * multiplier));
    }

    // console.log('[payments] createCheckoutSession debug:', {
    //   bookingId: booking ? String(booking._id || booking.bookingRef) : null,
    //   bookingRef,
    //   providedAmount: amount,
    //   majorAmountCandidate,
    //   taxes,
    //   addonsTotal,
    //   discountsTotal,
    //   majorAmountWithTaxes,
    //   currencyFinal,
    //   unitAmount,
    //   idempotencyKey
    // });

    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      return res.status(400).json({ message: 'Computed unit amount is invalid (zero or negative).' });
    }

    // pass idempotencyKey to Stripe SDK call options when provided
    const stripeOpts = {};
    try {
      if (idempotencyKey && booking) {
        const savedKey = String(booking.idempotencyKey || '');
        const savedAmt = Number((booking.price && booking.price.amount) || 0);
        const computedMajor = Number(Math.round(majorAmountWithTaxes || 0));
        if (savedKey && savedKey === String(idempotencyKey) && Number(savedAmt) === Number(computedMajor)) {
          stripeOpts.idempotencyKey = String(idempotencyKey);
        } else {
          stripeOpts.idempotencyKey = `${String(idempotencyKey || 'client')}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          if (booking && (!booking.idempotencyKey || booking.idempotencyKey !== stripeOpts.idempotencyKey)) {
            try { booking.idempotencyKey = stripeOpts.idempotencyKey; booking.save().catch(() => { }); } catch (e) {/* ignore */ }
          }
        }
      } else if (idempotencyKey) {
        stripeOpts.idempotencyKey = `${String(idempotencyKey)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      }
    } catch (e) {
      stripeOpts.idempotencyKey = `idemp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const session = await stripe.checkout.sessions.create({

      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currencyLower,
          product_data: {
            name: `Booking ${bookingRef || (booking && (booking.bookingRef || booking._id)) || 'flight'}`,
            description: `Flight booking ${bookingRef || (booking && booking._id) || ''}`
          },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      metadata: Object.assign({}, metadata || {}, booking ? { bookingId: String(booking._id), bookingRef: booking.bookingRef } : {}),
      success_url: `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/booking-details/${encodeURIComponent(booking ? (booking.bookingRef || booking._id) : '')}?paid=true`,
      cancel_url: `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/bookings`
    }, stripeOpts);

    // after const session = await stripe.checkout.sessions.create(..., stripeOpts);
    if (booking) {
      try {
        booking.stripeSessionId = session.id;
        booking.paymentStatus = booking.paymentStatus || 'PENDING';
        booking.bookingStatus = booking.bookingStatus || 'PENDING';
        booking.lastReconciledAt = new Date();
        if (!booking.price || booking.price.amount !== Number(Math.round(majorAmountWithTaxes || 0))) {
          booking.price = booking.price || {};
          booking.price.amount = Number(Math.round(majorAmountWithTaxes || 0));
        }

        // Persist the exact stripe request params + opts so later retries reuse them exactly
        try {
          const persisted = {
            params: {
              payment_method_types: ['card'],
              mode: 'payment',
              line_items: [{
                price_data: {
                  currency: currencyLower,
                  product_data: {
                    name: `Booking ${bookingRef || (booking && (booking.bookingRef || booking._id)) || 'flight'}`,
                    description: `Flight booking ${bookingRef || (booking && booking._id) || ''}`
                  },
                  unit_amount: unitAmount
                },
                quantity: 1
              }],
              metadata: Object.assign({}, metadata || {}, booking ? { bookingId: String(booking._id), bookingRef: booking.bookingRef } : {}),
              success_url: `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/booking-details/${encodeURIComponent(booking ? (booking.bookingRef || booking._id) : '')}?paid=true`,
              cancel_url: `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/bookings`
            },
            stripeOpts: stripeOpts || {}
          };
          if (!persisted.stripeOpts.idempotencyKey) {
            persisted.stripeOpts.idempotencyKey = booking.idempotencyKey || `server:${uuidv4()}`;
            booking.idempotencyKey = booking.idempotencyKey || persisted.stripeOpts.idempotencyKey;
          } else {
            booking.idempotencyKey = booking.idempotencyKey || String(persisted.stripeOpts.idempotencyKey);
          }
          booking.stripeSessionParams = persisted;
        } catch (serr) {
          console.warn('[payments] failed to persist stripeSessionParams', serr && serr.message);
        }

        await booking.save();
      } catch (err) {
        console.warn('[payments] could not attach session id to booking', err && err.message);
      }
    }

    return res.json({ url: session.url, id: session.id, debug: { majorAmountWithTaxes, unitAmount, currency: currencyLower } });
  } catch (err) {
    console.error('[payments] createCheckoutSession err', err && (err.stack || err));
    return res.status(500).json({ message: 'Failed to create checkout session', error: err && (err.message || String(err)) });
  }
};

/* webhook handler with confirmation email attempt */
exports.webhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event = null;
  let payloadRaw = null;

  if (req.rawBody) payloadRaw = req.rawBody;
  else if (Buffer.isBuffer(req.body)) payloadRaw = req.body;
  else {
    try { payloadRaw = JSON.stringify(req.body); } catch (e) { payloadRaw = ''; }
  }

  if (WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(payloadRaw, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('[payments] webhook signature verification failed:', err && (err.message || err));
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    try {
      event = typeof req.body === 'object' ? req.body : JSON.parse(payloadRaw || '{}');
      console.warn('[payments] WEBHOOK_SECRET not set — skipping signature verification (dev only)');
    } catch (err) {
      console.error('[payments] could not parse webhook payload', err);
      return res.status(400).send('Invalid payload');
    }
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const bookingId = session.metadata && (session.metadata.bookingId || session.metadata.booking_id);
        const bookingRef = session.metadata && (session.metadata.bookingRef || session.metadata.booking_ref);
        const paymentIntent = session.payment_intent || session.paymentIntent || session.payment_intent_id;

        // console.log('[payments] webhook: checkout.session.completed', {
        //   sessionId: session.id,
        //   bookingId,
        //   bookingRef,
        //   paymentIntent
        // });

        let updatedBooking = null;

        try {
          if (bookingId) {
            await Booking.findByIdAndUpdate(bookingId, {
              $set: {
                status: 'CONFIRMED',
                paymentProvider: 'stripe',
                paymentId: paymentIntent || session.id,
                paymentIntentId: paymentIntent || session.id,
                stripeSessionId: session.id || undefined,
                paymentStatus: 'PAID',
                bookingStatus: 'CONFIRMED',
                lastReconciledAt: new Date()
              },
              $inc: { reconciliationAttempts: 1 }
            });
            updatedBooking = await Booking.findById(bookingId).lean();
            if (updatedBooking) console.log('[payments] booking marked confirmed by bookingId', bookingId);
          }

          if (!updatedBooking && bookingRef) {
            await Booking.findOneAndUpdate({ bookingRef }, {
              $set: {
                status: 'CONFIRMED',
                paymentProvider: 'stripe',
                paymentId: paymentIntent || session.id,
                paymentIntentId: paymentIntent || session.id,
                stripeSessionId: session.id || undefined,
                paymentStatus: 'PAID',
                bookingStatus: 'CONFIRMED',
                lastReconciledAt: new Date()
              },
              $inc: { reconciliationAttempts: 1 }
            });
            updatedBooking = await Booking.findOne({ bookingRef }).lean();
            if (updatedBooking) console.log('[payments] booking marked confirmed by bookingRef', bookingRef);
          }

          if (!updatedBooking) {
            const found = await Booking.findOne({ stripeSessionId: session.id }).lean();
            if (found) {
              await Booking.updateOne({ _id: found._id }, {
                $set: {
                  status: 'CONFIRMED',
                  paymentProvider: 'stripe',
                  paymentId: paymentIntent || session.id,
                  paymentIntentId: paymentIntent || session.id,
                  paymentStatus: 'PAID',
                  bookingStatus: 'CONFIRMED',
                  lastReconciledAt: new Date()
                },
                $inc: { reconciliationAttempts: 1 }
              });
              updatedBooking = await Booking.findById(found._id).lean();
              if (updatedBooking) console.log('[payments] booking marked confirmed by stripeSessionId', found._id.toString());
            }
          }

          if (!updatedBooking && paymentIntent) {
            const foundByPi = await Booking.findOne({ $or: [{ paymentIntentId: paymentIntent }, { paymentId: paymentIntent }] }).lean();
            if (foundByPi) {
              await Booking.updateOne({ _id: foundByPi._id }, {
                $set: {
                  status: 'CONFIRMED',
                  paymentProvider: 'stripe',
                  paymentId: paymentIntent,
                  paymentIntentId: paymentIntent,
                  stripeSessionId: session.id || undefined,
                  paymentStatus: 'PAID',
                  bookingStatus: 'CONFIRMED',
                  lastReconciledAt: new Date()
                },
                $inc: { reconciliationAttempts: 1 }
              });
              updatedBooking = await Booking.findById(foundByPi._id).lean();
              if (updatedBooking) console.log('[payments] booking marked confirmed by paymentIntent match', foundByPi._id.toString());
            }
          }

          if (!updatedBooking) {
            console.warn('[payments] checkout.session.completed: could not find booking for session', session.id, 'metadata:', session.metadata);
          }
        } catch (err) {
          console.error('[payments] error updating booking on checkout.session.completed', err && (err.message || err));
        }

        // send confirmation email (best-effort)
        try {
          const emailer = (() => { try { return require('../utils/emailer'); } catch (e) { return null; } })();

          // async function logEmailPreview(payload) {
          //   if (process.env.NODE_ENV !== 'development') return;

          //   const { to, subject, text, pdfBuffer, booking } = payload;

          //   console.log("\n================ EMAIL PREVIEW ================");
          //   console.log("To:        ", to || "(no recipient)");
          //   console.log("Subject:   ", subject);
          //   console.log("Message:\n", text);
          //   console.log("----------------------------------------------");

          //   if (booking) {
          //     console.log("BookingRef:", booking.bookingRef);
          //     console.log("Passenger Count:", booking.passengers?.length);
          //     console.log("Seats:", booking.seats?.map(s => s.label || s.seatId).join(", "));
          //     console.log("Price:", JSON.stringify(booking.price));
          //   }

          //   console.log("PDF Attachment:", pdfBuffer ? "(attached)" : "(none)");
          //   console.log("==============================================\n");
          // }


          if (updatedBooking) {
            const TO = updatedBooking?.contact?.email || "unknown@example.com";
            const SUBJECT = `Booking Confirmed — ${updatedBooking.bookingRef}`;
            const TEXT =
              `Your booking ${updatedBooking.bookingRef} is confirmed.\n\n` +
              `Flight ID: ${updatedBooking.flightId}\n` +
              `Passengers: ${updatedBooking.passengers?.length}\n` +
              `Seats: ${updatedBooking.seats?.map(s => s.label || s.seatId).join(', ')}\n` +
              `Total Paid: ₹${updatedBooking.price?.amount}\n\n` +
              `Thank you for booking with us!`;

            if (emailer && typeof emailer.sendBookingConfirmation === 'function') {
              try {
                await emailer.sendBookingConfirmation(updatedBooking);
              } catch (err) {
                console.warn('[payments] sendBookingConfirmation failed', err?.message);
              }
            }

          }
        } catch (notifyErr) {
          console.error('[payments] post-payment notification error', notifyErr?.message);
        }

        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        if (pi && pi.id) {
          try {
            const bk = await Booking.findOne({ paymentIntentId: pi.id });
            if (bk) {
              await Booking.updateOne({ _id: bk._id }, {
                $set: { paymentStatus: 'PAID', bookingStatus: 'CONFIRMED', lastReconciledAt: new Date(), status: 'CONFIRMED', paymentProvider: 'stripe' },
                $inc: { reconciliationAttempts: 1 }
              });
              // console.log('[payments] payment_intent.succeeded updated booking', bk._id.toString());

              const updatedBooking = await Booking.findById(bk._id).lean().catch(() => null);

              try {
                const emailer = (() => { try { return require('../utils/emailer'); } catch (e) { return null; } })();
                if (emailer && updatedBooking) {
                  if (typeof emailer.sendBookingConfirmation === 'function') {
                    try {
                      await emailer.sendBookingConfirmation(updatedBooking);
                      console.log('[payments] sendBookingConfirmation invoked (payment_intent.succeeded)');
                    } catch (emErr) {
                      console.warn('[payments] sendBookingConfirmation failed', emErr && emErr.message);
                    }
                  }
                }
              } catch (notifyErr) {
                console.error('[payments] notification error (payment_intent.succeeded)', notifyErr && (notifyErr.message || notifyErr));
              }
            }
          } catch (err) {
            console.error('[payments] error mapping payment_intent.succeeded', err && err.message);
          }
        }
        break;
      }

      default:
      // console.log('[payments] unhandled event type', event.type);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[payments] webhook handler error', err && (err.stack || err));
    res.status(500).end();
  }
};
