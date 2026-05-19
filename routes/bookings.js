// routes/bookings.js
const express = require('express');
const router = express.Router();
const bookingsCtrl = require('../controllers/bookingsController');
const auth = require('../middleware/authMiddleware');

// NOTE: Order matters — named routes MUST come BEFORE /:id param routes.

// /me  — primary endpoint the frontend tries first (MyBookings page)
router.get('/me', auth, bookingsCtrl.listMine);

// /mine — legacy alias (kept for backward compat)
router.get('/mine', auth, bookingsCtrl.listMine);

// Create booking (authenticated; controller allows guest fallback)
router.post('/', auth, bookingsCtrl.create);

// Named sub-routes — must all be declared BEFORE /:id
router.get('/user/:userId', bookingsCtrl.listByUser);
router.get('/ref/:ref', bookingsCtrl.getByRef);

// Cancellation policy (no auth needed)
router.get('/:id/cancellation-policy', bookingsCtrl.getCancellationPolicy);

// Cancel booking
router.post('/:id/cancel', auth, bookingsCtrl.cancel);

// Status update
router.post('/:id/status', auth, bookingsCtrl.updateStatus);

// PDF downloads
router.get('/:id/itinerary.pdf', bookingsCtrl.downloadItineraryPDF);
router.get('/:id/refund.pdf', bookingsCtrl.downloadRefundPDF);

// Email resend endpoints
router.post('/:id/resend-confirmation', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'booking id required' });
    return bookingsCtrl.resendConfirmation(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resend-refund-confirmation', bookingsCtrl.resendRefundConfirmation);

// Public fetch by id or bookingRef — must be LAST
router.get('/:id', bookingsCtrl.getOne);

module.exports = router;
