const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const Booking = require('../../models/Booking');

router.use(adminAuth);

/**
 * GET /admin/payments/retries
 */
router.get('/retries', async (req, res) => {
  const failed = await Booking.find({
    paymentStatus: { $in: ['FAILED', 'RETRYING'] }
  })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();

  res.json({ ok: true, bookings: failed });
});

module.exports = router;
