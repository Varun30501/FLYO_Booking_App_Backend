// routes/bookings.js
const express = require('express');
const router = express.Router();
const bookingsCtrl = require('../controllers/bookingsController');
const auth = require('../middleware/authMiddleware'); // keep your auth middleware

// NOTE: Order matters.
// /mine must come BEFORE /:id
router.get('/mine', auth, bookingsCtrl.listMine);

// Create booking (authenticated; controller allows guest fallback)
router.post('/', auth, bookingsCtrl.create);

// --- NEW: Cancel booking route ---
router.get('/:id/cancellation-policy', bookingsCtrl.getCancellationPolicy);
// Place BEFORE '/:id'
router.post('/:id/cancel', auth, bookingsCtrl.cancel);

// Public fetch by id or bookingRef
router.get('/:id', bookingsCtrl.getOne);

// Update status (partial update)
router.post('/:id/status', auth, bookingsCtrl.updateStatus);

// Legacy list by user id
router.get('/user/:userId', bookingsCtrl.listByUser);

// get by ref
router.get('/ref/:ref', bookingsCtrl.getByRef);

router.get('/:id/itinerary.pdf', bookingsCtrl.downloadItineraryPDF);

// resend confirmation email
router.post('/:id/resend-confirmation', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: 'booking id required' });
    return bookingsCtrl.resendConfirmation(req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
