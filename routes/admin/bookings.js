// routes/admin/bookings.js
const express = require('express');
const router = express.Router();
const adminAuth = require('../../middleware/adminAuth');
const ctrl = require('../../controllers/adminBookingsController');

router.use(adminAuth);

router.get('/', ctrl.listBookings);
router.get('/:id', ctrl.getBooking);
router.post('/:id/cancel', ctrl.adminCancelBooking);
router.post('/:id/resend-payment', ctrl.resendPaymentLink);
router.post('/:id/retry-ticket', ctrl.retryTicketing);

module.exports = router;
