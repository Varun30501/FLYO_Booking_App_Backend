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
    const bookings = await Booking.find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json({ ok: true, bookings });
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
    req.body = {
      refund: true,
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

    // 🔒 Already paid
    if (booking.paymentStatus === 'PAID') {
      return res.status(400).json({ ok: false, error: 'Payment already completed' });
    }

    // 🔒 Hard cutoffs
    const MAX_DAYS = Number(process.env.PAYMENT_RETRY_MAX_DAYS || 3);
    const MAX_ATTEMPTS = Number(process.env.PAYMENT_RETRY_MAX_ATTEMPTS || 5);

    const ageDays =
      (Date.now() - booking.createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (ageDays > MAX_DAYS) {
      return res.status(400).json({ ok: false, error: 'Payment window expired' });
    }

    const attempts = booking.reconciliationAttempts || 0;
    if (attempts >= MAX_ATTEMPTS) {
      return res.status(400).json({ ok: false, error: 'Retry limit exceeded' });
    }

    if (!booking.contact?.email) {
      return res.status(400).json({ ok: false, error: 'Missing contact email' });
    }

    // 🧠 Build Stripe params once
    const stripeSessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: booking.contact.email,
      line_items: [{
        price_data: {
          currency: booking.price.currency || 'INR',
          product_data: { name: `Flight Booking ${booking.bookingRef}` },
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


    // ✅ CREATE Stripe Checkout session
    const session = await stripe.checkout.sessions.create(
      stripeSessionParams,
      { idempotencyKey: `resend_${booking._id}_${Date.now()}` }
    );


    // 📝 Persist retry state
    booking.stripeSessionId = session.id;
    booking.lastPaymentLinkUrl = session.url; // 🔑 IMPORTANT
    booking.paymentStatus = 'PENDING';
    booking.reconciliationAttempts = attempts + 1;
    booking.lastReconciledAt = new Date();
    await booking.save();

    // 📧 Send Stripe Checkout link
    await emailer.sendPaymentLink({
      to: booking.contact.email,
      bookingRef: booking.bookingRef,
      paymentUrl: session.url,
      amount: booking.price.amount,
      currency: booking.price.currency || 'INR'
    });

    return res.json({
      ok: true,
      paymentUrl: session.url,
      attempts: booking.reconciliationAttempts
    });

  } catch (err) {
    console.error('[adminBookings] resendPaymentLink fatal', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
};
