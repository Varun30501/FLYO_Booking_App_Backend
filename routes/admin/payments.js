// routes/admin/payments.js
const express  = require('express');
const router   = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const Booking  = require('../../models/Booking');

router.use(adminAuth);

/**
 * GET /admin/payments
 * Derives payment records from Booking model (single source of truth).
 * Supports ?search=, ?status=, ?page=, ?limit=
 */
router.get('/', async (req, res) => {
  try {
    const { search = '', status = '', limit = 200, page = 1 } = req.query || {};
    const skip = (Math.max(1, Number(page)) - 1) * Math.min(500, Number(limit));
    const take = Math.min(500, Number(limit));

    const query = {};

    // Payment status filter
    if (status && status !== 'ALL') {
      const map = {
        PAID:     ['PAID', 'COMPLETED'],
        PENDING:  ['PENDING'],
        FAILED:   ['FAILED'],
        REFUNDED: ['REFUNDED', 'PARTIALLY_REFUNDED']
      };
      const statuses = map[status.toUpperCase()];
      if (statuses) query.paymentStatus = { $in: statuses };
    }

    // Text search
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { bookingRef:     re },
        { 'contact.email': re },
        { 'contact.name':  re },
        { paymentIntentId: re },
        { chargeId:        re }
      ];
    }

    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
      .select('bookingRef paymentStatus paymentProvider paymentIntentId chargeId price createdAt contact origin destination')
      .lean();

    // Map to payment-shaped records
    const payments = bookings.map(b => ({
      _id:            b._id,
      bookingRef:     b.bookingRef   || b._id?.toString().slice(-8).toUpperCase(),
      bookingId:      b._id,
      status:         (b.paymentStatus || 'PENDING').toUpperCase(),
      amount:         b.price?.amount   ?? 0,
      currency:       b.price?.currency ?? 'INR',
      provider:       b.paymentProvider || 'stripe',
      paymentIntentId: b.paymentIntentId || null,
      chargeId:       b.chargeId        || null,
      route:          b.origin && b.destination ? `${b.origin}→${b.destination}` : null,
      contact:        b.contact          || {},
      createdAt:      b.createdAt
    }));

    // Also try Payment model if it exists (optional enrichment)
    let enriched = payments;
    try {
      const Payment = require('../../models/Payment');
      const paymentDocs = await Payment.find({}).sort({ createdAt: -1 }).limit(take).lean();
      if (paymentDocs.length > 0) {
        // Merge: Payment docs take priority, add any not already in bookings
        const refs = new Set(payments.map(p => String(p._id)));
        const extras = paymentDocs
          .filter(p => !refs.has(String(p.bookingId)))
          .map(p => ({
            _id:            p._id,
            bookingRef:     p.bookingRef || '—',
            bookingId:      p.bookingId,
            status:         (p.status || 'UNKNOWN').toUpperCase(),
            amount:         p.amount   ?? 0,
            currency:       p.currency ?? 'INR',
            provider:       p.provider || 'stripe',
            paymentIntentId: p.raw?.id || null,
            createdAt:      p.createdAt
          }));
        enriched = [...payments, ...extras];
      }
    } catch (e) {
      // Payment model may not exist — ignore
    }

    return res.json({ ok: true, payments: enriched, total: enriched.length });
  } catch (err) {
    console.error('[admin/payments] error:', err?.message);
    return res.status(500).json({ ok: false, error: 'Server error', payments: [] });
  }
});

/**
 * GET /admin/payments/retries
 */
router.get('/retries', async (req, res) => {
  try {
    const failed = await Booking.find({
      paymentStatus: { $in: ['FAILED', 'PENDING'] },
      bookingStatus: { $nin: ['CANCELLED'] }
    }).sort({ updatedAt: -1 }).limit(100).lean();
    return res.json({ ok: true, bookings: failed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
