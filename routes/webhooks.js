// routes/webhooks.js
const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const crypto = require('crypto');

function verifyHmac(secret, payloadRaw, signatureHeader) {
  if (!secret) return true; // accept in dev if no secret
  const hmac = crypto.createHmac('sha256', secret).update(payloadRaw).digest('hex');
  return (signatureHeader === hmac);
}

// Provider sends JSON: { bookingId, providerBookingId, status, raw }
router.post('/', express.json(), async (req, res) => {
  try {
    const secret = process.env.PROVIDER_WEBHOOK_SECRET || null;
    const signatureHeader = req.get('x-provider-signature') || req.get('x-signature') || null;
    const payloadRaw = JSON.stringify(req.body || {});

    if (!verifyHmac(secret, payloadRaw, signatureHeader)) {
      return res.status(401).json({ success: false, message: 'invalid signature' });
    }

    const { bookingId, providerBookingId, status, raw } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, message: 'bookingId required' });

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ success: false, message: 'booking not found' });

    if (providerBookingId) booking.providerBookingId = providerBookingId;
    if (status) booking.status = status.toUpperCase();
    if (raw) booking.rawProviderResponse = raw;

    await booking.save();
    return res.json({ success: true, booking });
  } catch (err) {
    console.error('[webhooks] providers error', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
