// controllers/adminBookingsController.js
const Booking = require('../models/Booking');
const mongoose = require('mongoose');
const bookingsController = require('./bookingsController');
const emailer = require('../utils/emailer');
const Stripe = require('stripe');

const STRIPE_SECRET =
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET || '';

if (!STRIPE_SECRET) {
  console.warn('[adminBookings] STRIPE SECRET KEY is missing');
}

// ✅ SINGLE Stripe instance (use this everywhere)
const stripe = Stripe(STRIPE_SECRET);

/**
 * GET /admin/bookings
 */
exports.listBookings = async (req, res) => {
  try {
    const {
      search = '',
      status = '',
      paymentStatus = '',
      limit = 200,
      page = 1
    } = req.query || {};

    const query = {};

    // Status filters
    if (status && status !== 'ALL') {
      if (status === 'CONFIRMED') {
        query['$or'] = [{ bookingStatus: 'CONFIRMED' }, { bookingStatus: 'TICKETED' }];
      } else {
        query.bookingStatus = status;
      }
    }
    if (paymentStatus && paymentStatus !== 'ALL') {
      query.paymentStatus = paymentStatus;
    }

    // Text search across ref, contact email/name, route
    if (search) {
      const re = new RegExp(search, 'i');
      const searchOr = [
        { bookingRef: re },
        { 'contact.email': re },
        { 'contact.name': re },
        { origin: re },
        { destination: re },
        { flightNumber: re }
      ];
      if (query['$or']) {
        query['$and'] = [{ '$or': query['$or'] }, { '$or': searchOr }];
        delete query['$or'];
      } else {
        query['$or'] = searchOr;
      }
    }

    const skip = (Math.max(1, Number(page)) - 1) * Math.min(500, Number(limit));
    const take = Math.min(500, Number(limit));

    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .lean();

    const total = (search || status || paymentStatus)
      ? await Booking.countDocuments(query)
      : await Booking.estimatedDocumentCount();

    res.json({ ok: true, bookings, total });
  } catch (e) {
    console.error('[adminBookings] list error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};

/**
 * GET /admin/bookings/:id
 */
exports.getBooking = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = mongoose.isValidObjectId(id)
      ? await Booking.findById(id).lean()
      : await Booking.findOne({ bookingRef: id }).lean();

    if (!booking) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }

    res.json({ ok: true, booking });
  } catch (e) {
    console.error('[adminBookings] get error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};

/**
 * POST /admin/bookings/:id/cancel
 */
exports.adminCancelBooking = async (req, res, next) => {
  try {
    const { id } = req.params;

    const booking = mongoose.isValidObjectId(id)
      ? await Booking.findById(id)
      : await Booking.findOne({ bookingRef: id });

    if (!booking) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }

    // 🔑 Admin logic: refund ONLY if payment actually happened
    const shouldRefund =
      booking.paymentStatus === 'PAID' && Boolean(booking.paymentIntentId);

    req.body = {
      refund: shouldRefund,
      restoreInventory: true,
      reason: 'Cancelled by admin',
      adminForce: true
    };

    return bookingsController.cancel(req, res, next);
  } catch (e) {
    console.error('[adminBookings] cancel error', e);
    res.status(500).json({ ok: false, error: 'server error' });
  }
};


exports.retryTicketing = async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ ok: false });

  booking.ticketStatus = 'PENDING';
  booking.ticketingAttempts = 0;
  await booking.save();

  return res.json({ ok: true });
};

/**
 * POST /admin/bookings/:id/resend-payment
 */
exports.resendPaymentLink = async (req, res) => {
  try {
    const { id } = req.params;

    const booking = await Booking.findById(id);
    if (!booking) {
      return res.status(404).json({ ok: false, error: 'Booking not found' });
    }

    // Block cancelled / failed bookings
    const bStatus = (booking.bookingStatus || '').toUpperCase();
    if (bStatus === 'CANCELLED' || bStatus === 'FAILED') {
      return res.status(400).json({ ok: false, error: `Cannot resend payment for a ${bStatus.toLowerCase()} booking` });
    }

    // Already paid — still allow resend if admin explicitly wants to (just warn)
    if (booking.paymentStatus === 'PAID') {
      return res.status(400).json({ ok: false, error: 'Payment already completed for this booking' });
    }

    // Hard cutoffs — only apply if createdAt is a valid date
    const MAX_DAYS = Number(process.env.PAYMENT_RETRY_MAX_DAYS || 30); // raised default to 30 for admin use
    const MAX_ATTEMPTS = Number(process.env.PAYMENT_RETRY_MAX_ATTEMPTS || 10);

    if (booking.createdAt && booking.createdAt instanceof Date && !isNaN(booking.createdAt.getTime())) {
      const ageDays = (Date.now() - booking.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > MAX_DAYS) {
        return res.status(400).json({ ok: false, error: `Payment window expired (booking is ${Math.floor(ageDays)} days old, max ${MAX_DAYS})` });
      }
    }

    const attempts = booking.reconciliationAttempts || 0;
    if (attempts >= MAX_ATTEMPTS) {
      return res.status(400).json({ ok: false, error: `Retry limit reached (${attempts}/${MAX_ATTEMPTS} attempts)` });
    }

    if (!booking.contact?.email) {
      return res.status(400).json({ ok: false, error: 'No contact email on booking — cannot send payment link' });
    }

    // Validate price
    const amount = Number(booking.price?.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid booking amount — cannot create payment session' });
    }

    const stripeSessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: booking.contact.email,
      line_items: [{
        price_data: {
          currency: (booking.price.currency || 'INR').toLowerCase(),
          product_data: { name: `Flight Booking – Ref: ${booking.bookingRef}` },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/booking-details/${booking.bookingRef}?payment=success`,
      cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:5173'}/booking-details/${booking.bookingRef}?payment=cancelled`,
      metadata: {
        bookingId:  booking._id.toString(),
        bookingRef: booking.bookingRef
      }
    };

    const session = await stripe.checkout.sessions.create(
      stripeSessionParams,
      { idempotencyKey: `resend_${booking._id}_${Date.now()}` }
    );

    booking.stripeSessionId           = session.id;
    booking.lastPaymentLinkUrl        = session.url;
    booking.paymentStatus             = 'PENDING';
    booking.reconciliationAttempts    = attempts + 1;
    booking.lastReconciledAt          = new Date();
    await booking.save();

    await emailer.sendPaymentLink({
      to:         booking.contact.email,
      bookingRef: booking.bookingRef,
      paymentUrl: session.url,
      amount:     amount,
      currency:   booking.price.currency || 'INR'
    });

    return res.json({
      ok:         true,
      paymentUrl: session.url,
      attempts:   booking.reconciliationAttempts,
      message:    `Payment link sent to ${booking.contact.email}`
    });

  } catch (err) {
    console.error('[adminBookings] resendPaymentLink fatal', err);
    return res.status(500).json({ ok: false, error: err.message || 'Server error' });
  }
};


/* ─────────────────────────────────────────────────────────────────────────
   DEBUG: GET /admin/bookings/:id/resend-debug
   Returns every field the resend guard checks — helps diagnose 400s.
──────────────────────────────────────────────────────────────────────────── */
exports.resendDebug = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).lean();
    if (!booking) return res.status(404).json({ ok: false, error: 'Not found' });

    const MAX_DAYS     = Number(process.env.PAYMENT_RETRY_MAX_DAYS     || 30);
    const MAX_ATTEMPTS = Number(process.env.PAYMENT_RETRY_MAX_ATTEMPTS || 10);
    const amount       = Number(booking.price?.amount);
    const ageDays      = booking.createdAt
      ? (Date.now() - new Date(booking.createdAt).getTime()) / 86400000
      : null;

    const checks = {
      bookingStatus:        booking.bookingStatus,
      paymentStatus:        booking.paymentStatus,
      reconcilerExcluded:   !!booking.reconcilerExcluded,
      contactEmail:         booking.contact?.email || null,
      priceAmount:          amount,
      reconciliationAttempts: booking.reconciliationAttempts || 0,
      ageDays:              ageDays !== null ? ageDays.toFixed(2) : 'createdAt missing',
      stripeConfigured:     !!STRIPE_SECRET,
      guards: {
        isCancelledOrFailed: ['CANCELLED','FAILED'].includes((booking.bookingStatus||'').toUpperCase()),
        isAlreadyPaid:       booking.paymentStatus === 'PAID',
        isExpired:           ageDays !== null ? ageDays > MAX_DAYS : true,
        retryLimitReached:   (booking.reconciliationAttempts||0) >= MAX_ATTEMPTS,
        missingEmail:        !booking.contact?.email,
        invalidAmount:       !amount || amount <= 0,
      }
    };

    const failingGuard = Object.entries(checks.guards).find(([,v]) => v);
    return res.json({
      ok: true,
      bookingRef: booking.bookingRef,
      failingGuard: failingGuard ? failingGuard[0] : null,
      wouldSucceed: !failingGuard,
      checks
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   POST /admin/bookings/:id/reconciler/exclude
   Permanently stops the reconciler from picking up this booking.
──────────────────────────────────────────────────────────────────────────── */
exports.reconcilerExclude = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false, error: 'Not found' });

    booking.reconcilerExcluded = true;
    booking.reconcilerNote     = req.body?.note || `Excluded by admin on ${new Date().toISOString()}`;
    await booking.save();

    return res.json({ ok: true, bookingRef: booking.bookingRef, reconcilerExcluded: true, note: booking.reconcilerNote });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
   POST /admin/bookings/:id/reconciler/unexclude
──────────────────────────────────────────────────────────────────────────── */
exports.reconcilerUnexclude = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ ok: false, error: 'Not found' });

    booking.reconcilerExcluded = false;
    booking.reconcilerNote     = '';
    await booking.save();

    return res.json({ ok: true, bookingRef: booking.bookingRef, reconcilerExcluded: false });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
