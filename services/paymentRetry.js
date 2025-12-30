// services/paymentRetry.js
'use strict';

const Booking = require('../models/Booking');
const ReconciliationLog = require('../models/ReconciliationLog');
const emailer = require('../utils/emailer');
const airlines = require('../services/airlines/adapter');
const Stripe = require('stripe');
require('dotenv').config();

/* ===========================
   CONFIG
=========================== */

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET ? Stripe(STRIPE_SECRET) : null;

const MAX_RETRIES = Number(process.env.PAYMENT_RETRY_MAX_ATTEMPTS || 5);
const MAX_RETRY_DAYS = Number(process.env.PAYMENT_RETRY_MAX_DAYS || 3);

const BASE_DELAY_MIN = Number(process.env.PAYMENT_RETRY_BASE_MIN || 5);
const MAX_DELAY_MIN = Number(process.env.PAYMENT_RETRY_MAX_MIN || 60);

const DEBUG = String(process.env.RECONCILE_DEBUG || 'false') === 'true';

/* ===========================
   HELPERS
=========================== */

function isExpired(booking) {
  if (!booking?.createdAt) return true;
  const ageMs = Date.now() - new Date(booking.createdAt).getTime();
  return ageMs > MAX_RETRY_DAYS * 24 * 60 * 60 * 1000;
}

/* ===========================
   CORE RECONCILER
=========================== */

async function reconcileOnce({
  limit = 50,
  dryRun = false,
  runBy = 'system'
} = {}) {

  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const result = {
    checked: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
    errors: 0
  };

  const entries = [];

  const bookings = await Booking.find({
    paymentStatus: 'PENDING',
    bookingStatus: 'PENDING'
  })
    .sort({ createdAt: 1 })
    .limit(limit);

  for (const booking of bookings) {
    result.checked++;

    try {
      /* ❌ HARD EXPIRY */
      if (isExpired(booking)) {
        entries.push({
          bookingId: booking._id,
          beforePaymentStatus: 'PENDING',
          afterPaymentStatus: 'FAILED',
          beforeBookingStatus: 'PENDING',
          afterBookingStatus: 'CANCELLED',
          result: 'EXPIRED',
          message: 'Payment retry window expired'
        });

        booking.bookingStatus = 'CANCELLED';
        booking.paymentStatus = 'FAILED';
        booking.lastReconciledAt = new Date();

        if (!dryRun) await booking.save();
        result.expired++;
        continue;
      }

      /* ⛔ RETRY LIMIT */
      const attempts = booking.reconciliationAttempts || 0;
      if (attempts >= MAX_RETRIES) {
        entries.push({
          bookingId: booking._id,
          beforePaymentStatus: booking.paymentStatus,
          afterPaymentStatus: 'FAILED',
          beforeBookingStatus: booking.bookingStatus,
          afterBookingStatus: 'CANCELLED',
          result: 'EXPIRED',
          message: 'Max payment retry attempts exceeded'
        });

        booking.paymentStatus = 'FAILED';
        booking.bookingStatus = 'CANCELLED';
        booking.lastReconciledAt = new Date();

        if (!dryRun) await booking.save();

        result.expired++;
        continue;
      }


      /* ⏱️ EXPONENTIAL BACKOFF */
      const delayMin = Math.min(
        MAX_DELAY_MIN,
        BASE_DELAY_MIN * Math.pow(2, attempts)
      );

      const lastTs = booking.lastReconciledAt
        ? new Date(booking.lastReconciledAt).getTime()
        : 0;

      const minutesSinceLast = (Date.now() - lastTs) / 60000;
      if (minutesSinceLast < delayMin) {
        entries.push({
          bookingId: booking._id,
          result: 'SKIPPED',
          message: `Backoff active (${delayMin} min)`
        });
        result.skipped++;
        continue;
      }

      /* 🔗 ENSURE STRIPE PAYMENT LINK */
      if (!booking.lastPaymentLinkUrl) {
        if (!booking.stripeSessionParams?.params) {
          entries.push({
            bookingId: booking._id,
            result: 'SKIPPED',
            message: 'Missing persisted stripeSessionParams'
          });
          result.skipped++;
          continue;
        }

        const session = await stripe.checkout.sessions.create(
          booking.stripeSessionParams.params,
          booking.stripeSessionParams.stripeOpts || {
            idempotencyKey: `auto_retry_${booking._id}`
          }
        );

        booking.stripeSessionId = session.id;
        booking.lastPaymentLinkUrl = session.url;
      }


      /* 📧 SEND PAYMENT EMAIL */
      if (!dryRun) {
        await emailer.sendPaymentLink({
          to: booking.contact.email,
          bookingRef: booking.bookingRef,
          paymentUrl: booking.lastPaymentLinkUrl,
          amount: booking.price?.amount,
          currency: booking.price?.currency || 'INR'
        });

        booking.reconciliationAttempts = attempts + 1;
        booking.lastReconciledAt = new Date();
        await booking.save();
      }

      entries.push({
        bookingId: booking._id,
        paymentIdUsed: booking.stripeSessionId,
        beforePaymentStatus: 'PENDING',
        afterPaymentStatus: 'PENDING',
        beforeBookingStatus: 'PENDING',
        afterBookingStatus: 'PENDING',
        result: 'RETRIED',
        message: 'Payment link resent'
      });

      result.retried++;

    } catch (err) {
      console.error('[paymentRetry] error', booking.bookingRef, err);

      entries.push({
        bookingId: booking._id,
        result: 'ERROR',
        message: err.message
      });

      result.errors++;
    }
  }

  /* 🧾 WRITE RECONCILIATION LOG */
  if (!dryRun) {
    await ReconciliationLog.create({
      runAt: new Date(),
      runBy,
      processedCount: result.checked,
      updatedCount: result.retried,
      failedCount: result.errors,
      expiredCount: result.expired,
      entries
    });
  }
  /* 🎟️ PHASE C: TICKETING RETRY (AFTER PAYMENT RECONCILIATION) */
  try {
    if (!dryRun) {
      await retryTicketing();
    }
  } catch (e) {
    console.error('[reconcileOnce] ticketing retry failed', e && e.message);
  }

  return result;
}

// ---- Phase C: Ticketing retry ----
async function retryTicketing() {
  const MAX_TICKET_RETRIES = Number(process.env.TICKET_RETRY_MAX || 3);

  const bookings = await Booking.find({
    paymentStatus: 'PAID',
    ticketStatus: 'PENDING',
    ticketingAttempts: { $lt: MAX_TICKET_RETRIES }
  }).limit(5);

  for (const booking of bookings) {
    try {
      booking.ticketingAttempts += 1;
      await booking.save();

      const result = await airlines.issueTicket({ booking });

      if (result.ok) {
        booking.ticketStatus = 'ISSUED';
        booking.providerPNR = result.pnr;
        booking.rawProviderResponse = result.raw;
      } else {
        booking.ticketStatus = 'FAILED';
      }

      await booking.save();
    } catch (err) {
      console.error('[ticketing] retry error', err);
    }
  }
}


/* ===========================
   EXPORTS
=========================== */

module.exports = {
  reconcileOnce
};
