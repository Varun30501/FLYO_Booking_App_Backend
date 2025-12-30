// routes/payments.js
const express = require('express');
const router = express.Router();
const paymentsCtrl = require('../controllers/paymentsController');
const auth = require('../middleware/authMiddleware');

// Create checkout session (accepts bookingId or bookingRef)
router.post('/create-checkout-session', express.json(), paymentsCtrl.createCheckoutSession);

// Stripe webhook endpoint: must be mounted with raw body parser in app.js
router.post('/webhook', express.raw({ type: 'application/json' }), paymentsCtrl.webhook);

router.post('/refund', auth, paymentsCtrl.refundPayment);

module.exports = router;
